import type { DatabaseClient } from '../db/supabase.js';
import type { AIProvider } from '../providers/ai/ai-provider.interface.js';
import type { EmbeddingProvider } from '../providers/embedding/embedding-provider.interface.js';
import { createTaskAIProvider } from '../providers/ai/index.js';
import { createEmbeddingProvider } from '../providers/embedding/index.js';
import { isKnowledgeTopic } from '../config/knowledge-topics.js';
import { FACT_LIKE_RULE, OWNER_MESSAGE_KINDS, OWNER_MESSAGE_PROMPT, RULE_NO_WORDS, RULE_YES_WORDS, type OwnerMessageKind } from '../config/owner-rules.js';
import { activeFacts, embedTexts } from './business-facts.service.js';
import { meterAI } from './metered-providers.js';
import { reserveKnowledgeIndex } from './knowledge-index-rate-limit.js';
import { behavior } from './runtime-settings.service.js';
import { renderText } from './templates.service.js';
import type { OwnerSettings } from './owner-settings.service.js';
import { HttpError } from '../utils/http-error.js';

/**
 * Z11: the owner's rules. The owner writes in ordinary words (WhatsApp «Нужен ответ» or the cabinet); the task model
 * says what was meant; the assistant answers «Поняла так: … Сохранить? Да / Нет» and saves only after «Да». A rule
 * that names prices, dates, hours or addresses is saved as a fact; a rule against the core is refused with an
 * allowed variant; a rule that needs data first asks for it and saves fact and rule in one confirmation.
 */
const check = (error: unknown, message: string) => { if (error) throw new Error(message); };
export type Rule = { id: string; number: number; text: string };
export type Source = 'cabinet' | 'whatsapp';
export type Proposal = { id: string; action: 'add' | 'edit' | 'remove' | 'fact' | 'fact_rule'; rule_number: number | null; rule_text: string | null; fact_text: string | null;
  fact_topic: string | null; status: string; details_question: string | null; source: Source; message_ids: string[]; created_at: string };
export type Understanding = { kind: OwnerMessageKind; number: number | null; rule: string | null; fact: string | null; factTopic: string | null;
  conflict: { reason: string; alternative: string } | null; needsDetails: string | null; answer: string | null };
/** What the owner sees next: the text of the reply and, when something waits for «Да», the proposal. */
export type Step = { reply: string; proposal: Proposal | null; kind: OwnerMessageKind | 'confirmed' | 'declined' | 'details' };

const PROPOSAL_COLUMNS = 'id,action,rule_number,rule_text,fact_text,fact_topic,status,details_question,source,message_ids,created_at';
const normalize = (text: string) => text.trim().toLowerCase().replace(/[.!…]+$/g, '').replace(/ё/g, 'е');
export const isYes = (text: string) => RULE_YES_WORDS.includes(normalize(text));
export const isNo = (text: string) => RULE_NO_WORDS.includes(normalize(text));
const lang = (settings: OwnerSettings) => { const l = behavior(settings).owner_language; return l === 'he' || l === 'en' ? l : 'ru'; };

export async function activeRules(db: DatabaseClient, tenantId: string): Promise<Rule[]> {
  const r = await db.from('owner_rules').select('id,number,text').eq('tenant_id', tenantId).eq('active', true).order('number', { ascending: true });
  check(r.error, 'Owner rules unavailable');
  return (r.data ?? []) as Rule[];
}
/** The block of the reply prompt: after the instruction, before the facts. Null when there are no rules. */
export function rulesBlock(rules: Rule[]): string | null {
  return rules.length ? rules.map(r => `${r.number}. ${r.text}`).join('\n') : null;
}
const numbered = (rules: Rule[]) => rules.map(r => `${r.number}. ${r.text}`).join('\n');

function parseUnderstanding(raw: string): Understanding | null {
  const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  let value: Record<string, unknown>;
  try { value = JSON.parse(json) as Record<string, unknown>; } catch { return null; }
  const text = (v: unknown, max: number) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
  const kind = (OWNER_MESSAGE_KINDS as readonly string[]).includes(String(value.kind)) ? value.kind as OwnerMessageKind : null;
  if (!kind) return null;
  const conflict = value.conflict && typeof value.conflict === 'object' ? value.conflict as Record<string, unknown> : null;
  return { kind, number: Number.isSafeInteger(value.number) && Number(value.number) > 0 ? Number(value.number) : null,
    rule: text(value.rule, 1000), fact: text(value.fact, 1000), factTopic: isKnowledgeTopic(value.fact_topic) ? value.fact_topic : null,
    conflict: conflict && text(conflict.reason, 300) && text(conflict.alternative, 1000) ? { reason: text(conflict.reason, 300)!, alternative: text(conflict.alternative, 1000)! } : null,
    needsDetails: text(value.needs_details, 300), answer: text(value.answer, 1500) };
}

/**
 * One task-model call under the tenant's knowledge-service limits (no client usage). `context` — what the owner
 * reacts to (a client question and the answer, a simulator turn). Null: no model, over the limit, or unreadable.
 */
export async function understandOwnerMessage(db: DatabaseClient, tenantId: string, settings: OwnerSettings, text: string,
  options: { context?: string | null; taskAI?: AIProvider | null; now?: Date } = {}): Promise<Understanding | null> {
  const config = behavior(settings), now = options.now ?? new Date();
  const base = options.taskAI === undefined ? createTaskAIProvider() : options.taskAI;
  if (!base) return null;
  const reservation = await reserveKnowledgeIndex(tenantId, config.knowledge_indexing_hourly_limit, config.knowledge_indexing_daily_limit, now);
  if (!reservation.allowed) return null;
  const rules = await activeRules(db, tenantId);
  const facts = (await activeFacts(db, tenantId)).map(f => `- [${f.topic}] ${f.text}`).join('\n').slice(0, 8000);
  const message = [`Язык владельца: ${lang(settings)}.`, `Правила сейчас:\n${numbered(rules) || '(нет)'}`, `Факты:\n${facts || '(нет)'}`,
    ...(options.context ? [`Контекст:\n${options.context.slice(0, 3000)}`] : []), `Сообщение владельца:\n${text.slice(0, 3000)}`].join('\n\n');
  try {
    const model = meterAI(db, tenantId, base, { purpose: 'owner_rules', billable_message: false })!;
    return parseUnderstanding((await model.generateReply({ systemPrompt: OWNER_MESSAGE_PROMPT, userMessage: message })).text);
  } catch { console.warn('owner_rules_understand_failed', { tenantId }); return null; }
}

async function insertProposal(db: DatabaseClient, tenantId: string, values: Partial<Proposal> & { action: Proposal['action']; source: Source }): Promise<Proposal> {
  // A new proposal replaces the one still waiting: «Да» always answers the last question.
  check((await db.from('owner_rule_proposals').update({ status: 'superseded', decided_at: new Date().toISOString() }).eq('tenant_id', tenantId).in('status', ['details', 'pending'])).error, 'Proposal update failed');
  const r = await db.from('owner_rule_proposals').insert({ tenant_id: tenantId, ...values }).select(PROPOSAL_COLUMNS).single();
  check(r.error || !r.data, 'Proposal save failed');
  return r.data as unknown as Proposal;
}
export async function attachMessage(db: DatabaseClient, proposal: Proposal, messageId: string): Promise<void> {
  check((await db.from('owner_rule_proposals').update({ message_ids: [...proposal.message_ids, messageId] }).eq('id', proposal.id)).error, 'Proposal update failed');
}
/** The proposal the owner answers: the quoted one, else the last open one younger than owner_rule_pending_hours. */
export async function openProposal(db: DatabaseClient, tenantId: string, settings: OwnerSettings, quotedKeys: string[], now = new Date()): Promise<Proposal | null> {
  if (quotedKeys.length) {
    for (const key of quotedKeys) {
      const r = await db.from('owner_rule_proposals').select(PROPOSAL_COLUMNS).eq('tenant_id', tenantId).contains('message_ids', [key]).in('status', ['details', 'pending']).limit(1);
      check(r.error, 'Proposals unavailable');
      if (r.data?.[0]) return r.data[0] as unknown as Proposal;
    }
    return null;
  }
  const since = new Date(now.getTime() - behavior(settings).owner_rule_pending_hours * 3_600_000).toISOString();
  const r = await db.from('owner_rule_proposals').select(PROPOSAL_COLUMNS).eq('tenant_id', tenantId).in('status', ['details', 'pending']).gte('created_at', since).order('created_at', { ascending: false }).limit(1);
  check(r.error, 'Proposals unavailable');
  return (r.data?.[0] as unknown as Proposal) ?? null;
}
export async function proposalById(db: DatabaseClient, tenantId: string, id: string): Promise<Proposal> {
  const r = await db.from('owner_rule_proposals').select(PROPOSAL_COLUMNS).eq('tenant_id', tenantId).eq('id', id).maybeSingle();
  check(r.error, 'Proposals unavailable');
  if (!r.data) throw new HttpError(404, 'Proposal not found', { code: 'rule_proposal_not_found' });
  return r.data as unknown as Proposal;
}

/** The «Поняла так …» text of a proposal. */
export function understoodText(settings: OwnerSettings, p: Proposal, conflictReason?: string | null): string {
  const l = lang(settings);
  if (p.status === 'details') return p.details_question ?? '';
  if (p.action === 'fact') return renderText(settings, 'owner.fact_understood', l, { text: p.fact_text ?? '' });
  if (p.action === 'fact_rule') return renderText(settings, 'owner.fact_rule_understood', l, { fact: p.fact_text ?? '', text: p.rule_text ?? '' });
  if (p.action === 'remove') return renderText(settings, 'owner.rule_remove_understood', l, { number: p.rule_number ?? '', text: p.rule_text ?? '' });
  if (conflictReason) return renderText(settings, 'owner.rule_conflict', l, { reason: conflictReason, text: p.rule_text ?? '' });
  if (p.action === 'edit') return renderText(settings, 'owner.rule_edit_understood', l, { number: p.rule_number ?? '', text: p.rule_text ?? '' });
  return renderText(settings, 'owner.rule_understood', l, { text: p.rule_text ?? '' });
}

/**
 * What the owner meant → the next step (no message is sent here). `forceEdit` (cabinet «изменить»): the text is the
 * new wording of that rule.
 */
export async function stepFor(db: DatabaseClient, tenantId: string, settings: OwnerSettings, u: Understanding, source: Source, forceEdit?: number | null): Promise<Step> {
  const l = lang(settings), config = behavior(settings), rules = await activeRules(db, tenantId);
  const kind: OwnerMessageKind = forceEdit ? 'edit_rule' : u.kind;
  const number = forceEdit ?? u.number;
  if (kind === 'list_rules') return { reply: rules.length ? renderText(settings, 'owner.rules_list', l, { list: numbered(rules) }) : renderText(settings, 'owner.rules_empty', l), proposal: null, kind };
  if (kind === 'undo') return { reply: await undoLast(db, tenantId, settings), proposal: null, kind };
  if (kind === 'question' || kind === 'other') return { reply: u.answer ?? renderText(settings, 'owner.owner_reply_15', l), proposal: null, kind };
  if (kind === 'fact' || ((kind === 'add_rule' || kind === 'edit_rule') && u.rule && FACT_LIKE_RULE.test(u.rule) && !u.conflict)) {
    // A rule with a price, date, hours or a time is a fact (the model said so, or the code sees it).
    const fact = (u.fact ?? u.rule ?? '').slice(0, 500);
    if (!fact) return { reply: renderText(settings, 'owner.owner_reply_15', l), proposal: null, kind };
    const p = await insertProposal(db, tenantId, { action: 'fact', fact_text: fact, fact_topic: u.factTopic ?? 'other', status: 'pending', source });
    return { reply: understoodText(settings, p), proposal: p, kind: 'fact' };
  }
  if (kind === 'remove_rule') {
    const rule = rules.find(r => r.number === number);
    if (!rule) return { reply: renderText(settings, 'owner.rule_not_found', l, { number: number ?? '' }), proposal: null, kind };
    const p = await insertProposal(db, tenantId, { action: 'remove', rule_number: rule.number, rule_text: rule.text, status: 'pending', source });
    return { reply: understoodText(settings, p), proposal: p, kind };
  }
  const text = (u.conflict?.alternative ?? u.rule ?? '').trim();
  if (!text) return { reply: renderText(settings, 'owner.owner_reply_15', l), proposal: null, kind };
  if (text.length > config.owner_rule_max_chars) return { reply: renderText(settings, 'owner.rule_too_long', l, { max: config.owner_rule_max_chars }), proposal: null, kind };
  if (kind === 'edit_rule') {
    const rule = rules.find(r => r.number === number);
    if (!rule) return { reply: renderText(settings, 'owner.rule_not_found', l, { number: number ?? '' }), proposal: null, kind };
    const p = await insertProposal(db, tenantId, { action: 'edit', rule_number: rule.number, rule_text: text, status: 'pending', source });
    return { reply: understoodText(settings, p, u.conflict?.reason), proposal: p, kind };
  }
  if (rules.length >= config.owner_rules_max) return { reply: renderText(settings, 'owner.rules_full', l, { max: config.owner_rules_max, list: numbered(rules) }), proposal: null, kind };
  if (u.needsDetails && !u.conflict) {
    const p = await insertProposal(db, tenantId, { action: 'fact_rule', rule_text: text, status: 'details', details_question: u.needsDetails, fact_topic: u.factTopic, source });
    return { reply: u.needsDetails, proposal: p, kind: 'details' };
  }
  const p = await insertProposal(db, tenantId, { action: 'add', rule_text: text, status: 'pending', source });
  return { reply: understoodText(settings, p, u.conflict?.reason), proposal: p, kind };
}

/** The owner answered the details question: the answer is the fact; fact and rule wait for one «Да». */
export async function completeDetails(db: DatabaseClient, tenantId: string, settings: OwnerSettings, p: Proposal, answer: string, u: Understanding | null): Promise<Step> {
  const fact = (u?.fact ?? answer).trim().slice(0, 500);
  const updated = await db.from('owner_rule_proposals').update({ status: 'pending', fact_text: fact, fact_topic: u?.factTopic ?? p.fact_topic ?? 'other' }).eq('id', p.id).select(PROPOSAL_COLUMNS).single();
  check(updated.error || !updated.data, 'Proposal update failed');
  const next = updated.data as unknown as Proposal;
  return { reply: understoodText(settings, next), proposal: next, kind: 'details' };
}

/**
 * «Да»: the whole change at once (confirm_owner_rule_proposal, 068): the proposal is claimed under a lock (a second
 * confirmation fails), the rule limit is checked before anything is written, and an error rolls everything back.
 * Only the fact's embedding is computed before (outside the transaction). Returns the confirmation text.
 */
export async function confirmProposal(db: DatabaseClient, tenantId: string, settings: OwnerSettings, p: Proposal, messageId: string | null,
  deps: { embedder?: EmbeddingProvider | null } = {}): Promise<string> {
  const l = lang(settings), config = behavior(settings);
  let vector: number[] | null = null, model: string | null = null;
  if ((p.action === 'fact' || p.action === 'fact_rule') && p.fact_text) {
    const embedder = deps.embedder === undefined ? createEmbeddingProvider() : deps.embedder;
    vector = (await embedTexts(db, tenantId, embedder, [p.fact_text], 'fact_embedding'))?.[0] ?? null;
    model = vector ? embedder!.model : null;
  }
  const r = await db.rpc('confirm_owner_rule_proposal', { p_tenant_id: tenantId, p_proposal_id: p.id, p_message_id: messageId, p_max_rules: config.owner_rules_max,
    p_fact_embedding: vector ? JSON.stringify(vector) : null, p_embedding_model: model, p_fact_title: 'Правило владельца' });
  if (r.error) {
    const message = String((r.error as { message?: string }).message ?? '');
    if (message.includes('rules_full')) throw new HttpError(409, 'Too many rules', { code: 'rules_full' });
    if (message.includes('proposal_closed')) throw new HttpError(409, 'Proposal is not waiting', { code: 'rule_proposal_closed' });
    if (message.includes('rule_not_found')) throw new HttpError(404, 'Rule not found', { code: 'rule_not_found' });
    throw new Error('Owner rule confirm failed');
  }
  const done = r.data as { action: Proposal['action']; rule_number: number | null; rule_text: string | null; fact_text: string | null };
  if (done.action === 'remove') return renderText(settings, 'owner.rule_removed', l, { number: done.rule_number ?? '' });
  if (done.action === 'fact') return renderText(settings, 'owner.fact_saved', l, { text: done.fact_text ?? '' });
  return renderText(settings, 'owner.rule_saved', l, { number: done.rule_number ?? '', text: done.rule_text ?? '' });
}
export async function declineProposal(db: DatabaseClient, settings: OwnerSettings, p: Proposal): Promise<string> {
  check((await db.from('owner_rule_proposals').update({ status: 'declined', decided_at: new Date().toISOString() }).eq('id', p.id)).error, 'Proposal update failed');
  return renderText(settings, 'owner.rule_declined', lang(settings));
}

/** «Отмени последнее»: the last confirmed change is turned back (a rule off / old text back / a fact archived). */
export async function undoLast(db: DatabaseClient, tenantId: string, settings: OwnerSettings): Promise<string> {
  const l = lang(settings);
  const r = await db.from('owner_rule_proposals').select('id,action,rule_id,previous_text,fact_id').eq('tenant_id', tenantId).eq('status', 'confirmed').order('decided_at', { ascending: false }).limit(1);
  check(r.error, 'Proposals unavailable');
  const last = r.data?.[0] as { id: string; action: string; rule_id: string | null; previous_text: string | null; fact_id: string | null } | undefined;
  if (!last) return renderText(settings, 'owner.undo_none', l);
  const now = new Date().toISOString();
  if (last.rule_id) {
    const values = last.action === 'edit' ? { text: last.previous_text, updated_at: now } : last.action === 'remove' ? { active: true, updated_at: now } : { active: false, updated_at: now };
    check((await db.from('owner_rules').update(values).eq('id', last.rule_id)).error, 'Owner rule save failed');
  }
  if (last.fact_id) check((await db.from('business_facts').update({ status: 'archived' }).eq('id', last.fact_id)).error, 'Fact update failed');
  check((await db.from('owner_rule_proposals').update({ status: 'undone' }).eq('id', last.id)).error, 'Proposal update failed');
  return renderText(settings, 'owner.undo_done', l);
}

/** Cabinet «удалить»: the rule is turned off at once (the dialog in the cabinet is the confirmation); undoable. */
export async function removeRuleNow(db: DatabaseClient, tenantId: string, number: number): Promise<void> {
  const rule = (await activeRules(db, tenantId)).find(r => r.number === number);
  if (!rule) throw new HttpError(404, 'Rule not found', { code: 'rule_not_found' });
  const now = new Date().toISOString();
  check((await db.from('owner_rules').update({ active: false, updated_at: now }).eq('id', rule.id)).error, 'Owner rule save failed');
  check((await db.from('owner_rule_proposals').insert({ tenant_id: tenantId, action: 'remove', rule_number: number, rule_text: rule.text, status: 'confirmed', source: 'cabinet', rule_id: rule.id, previous_text: rule.text, decided_at: now })).error, 'Proposal save failed');
}
