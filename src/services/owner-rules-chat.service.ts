import type { DatabaseClient } from '../db/supabase.js';
import type { AIProvider } from '../providers/ai/ai-provider.interface.js';
import { replyId } from '../utils/assistant-text.js';
import { outboundIdsForProviderId } from '../workers/outbound-queue.js';
import type { OwnerSettings } from './owner-settings.service.js';
import { behavior } from './runtime-settings.service.js';
import { renderText } from './templates.service.js';
import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { applySetting, declineSetting, helpText, pickChoice, proposeChoice, proposeSetting } from './owner-chat.service.js';
import { proposeSupport, submitSupport } from './support.service.js';
import { attachMessage, completeDetails, confirmProposal, declineProposal, isNo, isYes, openProposal, stepFor, understandOwnerMessage, type Understanding } from './owner-rules.service.js';

/**
 * Z11: the owner's messages in WhatsApp that are not answers to a client question — rules, facts, «какие правила»,
 * «отмени последнее», «Да / Нет» to «Сохранить?» and to «Запомнить на будущее?». `send` delivers a reply to the
 * chat the owner wrote in and returns its message id (proposals keep it, so a quoted «Да» finds them).
 */
type Send = (text: string, dedupe: string) => Promise<string>;
/** Z15: what a setting or a BizGenie request needs besides the database — WhatsApp (the operator's group) and the group rename. */
export type ChatDeps = { provider?: WhatsAppProvider; onRename?: () => Promise<void> };
const check = (error: unknown, message: string) => { if (error) throw new Error(message); };
const lang = (settings: OwnerSettings) => { const l = behavior(settings).owner_language; return l === 'he' || l === 'en' ? l : 'ru'; };
async function quotedKeys(db: DatabaseClient, tenantId: string, quoted: string | null): Promise<string[]> {
  return quoted ? [replyId(quoted), quoted, ...await outboundIdsForProviderId(db, tenantId, quoted)] : [];
}

/** «Да» / «Нет» / the details answer to an open «Сохранить?» (quoted, or the last one). True when handled. */
export async function answerProposal(db: DatabaseClient, tenantId: string, settings: OwnerSettings, text: string, quoted: string | null,
  inboundId: string | null, send: Send, ai?: AIProvider | null, deps: ChatDeps = {}): Promise<boolean> {
  const keys = await quotedKeys(db, tenantId, quoted);
  const proposal = await openProposal(db, tenantId, settings, keys);
  if (!proposal) return false;
  // Z15: options 1/2/3 — a digit picks one (it becomes the usual proposal with its own «Да»).
  if (proposal.action === 'choice') {
    const step = await pickChoice(db, tenantId, settings, proposal, text);
    if (!step && isNo(text)) { await send(await declineSetting(db, settings, proposal), `rule:${proposal.id}:declined`); return true; }
    if (!step) return false;
    const id = await send(step.reply, `rule:${proposal.id}:picked`);
    if (step.proposal) await attachMessage(db, step.proposal, id);
    return true;
  }
  if (proposal.action === 'setting' || proposal.action === 'support') {
    if (isYes(text)) {
      let reply: string;
      try { reply = proposal.action === 'setting' ? await applySetting(db, tenantId, settings, proposal, deps.onRename) : deps.provider ? await submitSupport(db, deps.provider, tenantId, settings, proposal) : renderText(settings, 'owner.support_unavailable', lang(settings)); }
      catch { console.error('owner_chat_apply_failed', { tenantId, action: proposal.action }); reply = renderText(settings, proposal.action === 'setting' ? 'owner.setting_invalid' : 'owner.support_unavailable', lang(settings)); }
      await send(reply, `rule:${proposal.id}:applied:${inboundId ?? Date.now()}`); // a retry after a failure is a new reply
      return true;
    }
    if (isNo(text)) { await send(await declineSetting(db, settings, proposal), `rule:${proposal.id}:declined`); return true; }
    return false;
  }
  if (proposal.status === 'details') {
    // The quote or the next message answers «Какие условия …?» — unless it is a plain «нет».
    if (isNo(text)) { await send(await declineProposal(db, settings, proposal), `rule:${proposal.id}:declined`); return true; }
    const u = await understandOwnerMessage(db, tenantId, settings, text, { context: proposal.details_question, ...(ai !== undefined ? { taskAI: ai } : {}) });
    const step = await completeDetails(db, tenantId, settings, proposal, text, u);
    const id = await send(step.reply, `rule:${proposal.id}:details`);
    if (step.proposal) await attachMessage(db, step.proposal, id);
    return true;
  }
  if (isYes(text)) {
    let reply: string;
    try { reply = await confirmProposal(db, tenantId, settings, proposal, inboundId); }
    catch (error) { reply = (error as { details?: { code?: string } }).details?.code === 'rules_full' ? renderText(settings, 'owner.rules_full', lang(settings), { max: behavior(settings).owner_rules_max, list: '' }).trim() : renderText(settings, 'owner.rules_unavailable', lang(settings)); }
    await send(reply, `rule:${proposal.id}:confirmed`);
    return true;
  }
  if (isNo(text)) { await send(await declineProposal(db, settings, proposal), `rule:${proposal.id}:declined`); return true; }
  // New text instead of «Да / Нет»: it is understood again (the new proposal replaces this one).
  return false;
}

/** «Запомнить на будущее?» — «Да» → the client question and the owner's answer go through the same understanding. */
export async function answerRemember(db: DatabaseClient, tenantId: string, settings: OwnerSettings, text: string, quoted: string | null,
  send: Send, ai?: AIProvider | null, now = new Date()): Promise<boolean> {
  if (!isYes(text) && !isNo(text)) return false;
  const keys = await quotedKeys(db, tenantId, quoted);
  type Remembered = { id: string; question: string; answer: string | null };
  let found: Remembered | null = null;
  if (keys.length) {
    const r = await db.from('escalations').select('id,question,answer').eq('tenant_id', tenantId).eq('remember_state', 'offered').in('remember_message_id', keys).limit(1);
    check(r.error, 'Escalations unavailable'); found = (r.data?.[0] as Remembered | undefined) ?? null;
  } else {
    const since = new Date(now.getTime() - behavior(settings).owner_rule_pending_hours * 3_600_000).toISOString();
    const r = await db.from('escalations').select('id,question,answer').eq('tenant_id', tenantId).eq('remember_state', 'offered').gte('delivered_at', since).order('delivered_at', { ascending: false }).limit(1);
    check(r.error, 'Escalations unavailable'); found = (r.data?.[0] as Remembered | undefined) ?? null;
  }
  if (!found) return false;
  if (isNo(text)) { check((await db.from('escalations').update({ remember_state: 'declined' }).eq('id', found.id)).error, 'Escalation update failed'); return true; }
  check((await db.from('escalations').update({ remember_state: 'accepted' }).eq('id', found.id)).error, 'Escalation update failed');
  const answer = found.answer ?? '';
  let u: Understanding | null = await understandOwnerMessage(db, tenantId, settings, answer, { context: `Вопрос клиента: ${found.question}\nОтвет владельца клиенту (владелец просит запомнить на будущее): ${answer}`, ...(ai !== undefined ? { taskAI: ai } : {}) });
  if (!u) { await send(renderText(settings, 'owner.rules_unavailable', lang(settings)), `remember:${found.id}:unavailable`); return true; }
  // «Запомнить» is always something to keep: a question/other reading becomes the answer as a fact.
  if (!['add_rule', 'edit_rule', 'fact'].includes(u.kind)) u = { ...u, kind: 'fact', fact: (u.fact ?? `${found.question} — ${answer}`).slice(0, 500) };
  const step = await stepFor(db, tenantId, settings, u, 'whatsapp');
  const id = await send(step.reply, `remember:${found.id}:understood`);
  if (step.proposal) await attachMessage(db, step.proposal, id);
  return true;
}

/** Any other owner message (not a quote): what did the owner mean? → a reply, and «Сохранить?» when something would change. */
export async function understandInChat(db: DatabaseClient, tenantId: string, settings: OwnerSettings, text: string, inboundId: string | null,
  send: Send, ai?: AIProvider | null, correction?: { quotedText: string; conversationId: string | null } | null): Promise<void> {
  // Z15: a quote of the assistant's answer to a client — a correction: first a rule (or a fact), BizGenie only when a rule cannot fix it.
  const context = correction ? `Владелец ответил реплеем на ответ ассистента клиенту и исправляет его.\nОтвет ассистента клиенту: ${correction.quotedText}` : null;
  const u = await understandOwnerMessage(db, tenantId, settings, text, { ...(context ? { context } : {}), ...(ai !== undefined ? { taskAI: ai } : {}) });
  const key = inboundId ?? `${Date.now()}`;
  // No model (or over the limit): the old hint — answer a question by quoting it.
  if (!u) { await send(renderText(settings, 'owner.owner_reply_15', lang(settings)), `rules:${key}:unavailable`); return; }
  const step = u.kind === 'setting' ? await proposeSetting(db, tenantId, settings, u.setting)
    : u.kind === 'support' ? await proposeSupport(db, tenantId, settings, { text, // Z15 review: the owner's words as written, not the model's retelling
 quotedText: correction?.quotedText ?? null, conversationId: correction?.conversationId ?? null })
    : u.kind === 'help' ? { reply: helpText(settings), proposal: null }
    : u.kind === 'ambiguous' && u.options ? await proposeChoice(db, tenantId, settings, u)
    : await stepFor(db, tenantId, settings, u, 'whatsapp');
  const id = await send(step.reply, `rules:${key}:reply`);
  if (step.proposal) await attachMessage(db, step.proposal, id);
}

/** After the owner's answer reached the client: «Запомнить на будущее? Да / Нет», once per question. */
export async function offerRemember(db: DatabaseClient, settings: OwnerSettings, escalation: { id: string; tenant_id: string }, send: Send): Promise<void> {
  const claimed = await db.from('escalations').update({ remember_state: 'offered' }).eq('id', escalation.id).is('remember_state', null).select('id');
  check(claimed.error, 'Escalation update failed');
  if (!claimed.data?.length) return;
  const id = await send(renderText(settings, 'owner.remember_offer', lang(settings)), `escalation:${escalation.id}:remember`);
  check((await db.from('escalations').update({ remember_message_id: id }).eq('id', escalation.id)).error, 'Escalation update failed');
}
