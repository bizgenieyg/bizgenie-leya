import type { DatabaseClient } from '../db/supabase.js';
import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import type { AIProvider } from '../providers/ai/ai-provider.interface.js';
import { createTaskAIProvider } from '../providers/ai/index.js';
import type { EmbeddingProvider } from '../providers/embedding/embedding-provider.interface.js';
import { createEmbeddingProvider } from '../providers/embedding/index.js';
import { behavior } from './runtime-settings.service.js';
import { isBusinessOwner, loadOwnerSettings, ownerDestination, type OwnerSettings } from './owner-settings.service.js';
import { renderText } from './templates.service.js';
import { enqueueMessage, outboundIdsForProviderId } from '../workers/outbound-queue.js';
import { scheduleWake } from '../workers/job-wake.js';
import { isWithinQuietHours, nextQuietHoursEnd } from './escalation.service.js';
import { replyId } from '../utils/assistant-text.js';
import { allowedRecipient } from '../utils/incoming-policy.js';
import { requiredTopics } from '../config/knowledge-topics.js';
import { GAP_QUESTIONS, INTERVIEW_POSTPONE_WORDS, LAUNCH_TOPICS } from '../config/instructions.js';
import { extractFacts, quoteInSource } from './fact-extraction.service.js';
import { activeFacts, addOwnerFact, saveExtraction } from './business-facts.service.js';
import { meterAI } from './metered-providers.js';
import { reserveKnowledgeIndex } from './knowledge-index-rate-limit.js';
import { intlTimeZone } from '../config/time-zones.js';

/**
 * Task Z owner interview: questions about missing data, one at a time in the owner's WhatsApp (next one
 * after the answer) and as cabinet cards. An answer — text or voice — goes through the fact extraction
 * as an owner source; the owner gets "Записала: …". Client escalations always go first.
 */
const check = (error: unknown, message: string) => { if (error) throw new Error(message); };
const DAY = 24 * 3_600_000;
export interface OwnerQuestion { id: string; question: string; priority: 'launch' | 'normal'; source: string; topic: string | null; status: string; postponed_count: number; next_at: string | null; sent_at: string | null; owner_message_ids: string[] }
const lang = (settings: OwnerSettings): 'ru' | 'he' | 'en' => { const l = behavior(settings).owner_language; return l === 'he' || l === 'en' ? l : 'ru'; };

/** "- [launch] Вопрос?" lines; other lines are ignored. */
export function parseQuestionList(markdown: string): Array<{ priority: 'launch' | 'normal'; question: string }> {
  return markdown.split('\n').flatMap(line => {
    const m = /^\s*[-*]\s*\[(launch|normal)\]\s*(.+?)\s*$/i.exec(line);
    return m && m[2]!.length <= 500 ? [{ priority: m[1]!.toLowerCase() as 'launch' | 'normal', question: m[2]! }] : [];
  });
}
export async function importOwnerQuestions(db: DatabaseClient, tenantId: string, markdown: string) {
  const items = parseQuestionList(markdown);
  let added = 0;
  for (const item of items) {
    const inserted = await db.from('owner_questions').insert({ tenant_id: tenantId, question: item.question, priority: item.priority, source: 'operator' });
    if (inserted.error && inserted.error.code !== '23505') throw new Error('Owner question save failed');
    if (!inserted.error) added++;
  }
  if (added) await ensureInterviewJob(db, tenantId);
  return { parsed: items.length, added };
}

/** Questions for required topics of the sector that have no active facts; closed when the topic gets facts. */
export async function syncGapQuestions(db: DatabaseClient, tenantId: string): Promise<number> {
  const tenant = await db.from('tenants').select('business_sector').eq('id', tenantId).maybeSingle();
  check(tenant.error, 'Tenant unavailable');
  const settings = await loadOwnerSettings(db, tenantId);
  const have = new Set((await activeFacts(db, tenantId)).map(f => f.topic));
  const existing = await db.from('owner_questions').select('id,topic,status').eq('tenant_id', tenantId).eq('source', 'gap');
  check(existing.error, 'Owner questions unavailable');
  let added = 0;
  for (const topic of requiredTopics(tenant.data?.business_sector as string | null)) {
    const row = (existing.data ?? []).find(r => r.topic === topic);
    if (have.has(topic)) { if (row && ['open', 'cabinet_only'].includes(String(row.status))) check((await db.from('owner_questions').update({ status: 'dropped' }).eq('id', row.id)).error, 'Owner question update failed'); continue; }
    if (row || !GAP_QUESTIONS[topic]) continue;
    const inserted = await db.from('owner_questions').insert({ tenant_id: tenantId, question: GAP_QUESTIONS[topic]![lang(settings)], topic, source: 'gap', priority: LAUNCH_TOPICS.includes(topic) ? 'launch' : 'normal' });
    if (inserted.error && inserted.error.code !== '23505') throw new Error('Owner question save failed');
    if (!inserted.error) added++;
  }
  return added;
}

export async function ensureInterviewJob(db: DatabaseClient, tenantId: string, at = new Date()): Promise<void> {
  const active = await db.from('scheduled_jobs').select('id,scheduled_at').eq('tenant_id', tenantId).eq('job_type', 'owner_interview').in('status', ['pending', 'sending']).limit(1);
  check(active.error, 'Interview job unavailable');
  const current = active.data?.[0];
  if (current) {
    if (new Date(String(current.scheduled_at)) > at) check((await db.from('scheduled_jobs').update({ scheduled_at: at.toISOString() }).eq('id', current.id).eq('status', 'pending')).error, 'Interview job update failed');
  } else {
    const inserted = await db.from('scheduled_jobs').insert({ tenant_id: tenantId, job_type: 'owner_interview', payload: {}, status: 'pending', scheduled_at: at.toISOString() });
    if (inserted.error && inserted.error.code !== '23505') throw new Error('Interview job save failed');
  }
  scheduleWake(at);
}

/** Start of the owner's calendar day (tenant time zone). */
function dayStart(settings: OwnerSettings, now: Date): Date {
  const zone = intlTimeZone(settings.time_zone ?? 'Asia/Jerusalem');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  const elapsed = (Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second)) * 1000 + now.getMilliseconds();
  return new Date(now.getTime() - elapsed);
}

/**
 * The job: sends the next question unless quiet hours, a client waits for the owner, a question is already
 * out, or today's limit is used (first day: owner_interview_first_batch, then owner_interview_daily_limit).
 * Returns when it should run again.
 */
export async function runOwnerInterview(db: DatabaseClient, tenantId: string, provider: WhatsAppProvider, now = new Date()): Promise<{ sent: string | null; next: Date | null }> {
  const settings = await loadOwnerSettings(db, tenantId), config = behavior(settings);
  const destination = ownerDestination(settings);
  const instance = await db.from('whatsapp_instances').select('session_name').eq('tenant_id', tenantId).maybeSingle();
  check(instance.error, 'Instance unavailable');
  if (!destination || !allowedRecipient(destination) || !instance.data?.session_name) return { sent: null, next: null };
  if (isWithinQuietHours(settings, now)) return { sent: null, next: nextQuietHoursEnd(settings, now) ?? new Date(now.getTime() + 3_600_000) };
  const waiting = await db.from('escalations').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).in('status', ['queued', 'notifying', 'pending', 'reminding']);
  check(waiting.error, 'Escalations unavailable');
  if ((waiting.count ?? 0) > 0) return { sent: null, next: new Date(now.getTime() + 3_600_000) };
  const rows = await db.from('owner_questions').select('id,question,priority,source,topic,status,postponed_count,next_at,sent_at,owner_message_ids,created_at').eq('tenant_id', tenantId).in('status', ['open', 'sent', 'answered']);
  check(rows.error, 'Owner questions unavailable');
  const all = (rows.data ?? []) as unknown as Array<OwnerQuestion & { created_at: string }>;
  const tomorrow = new Date(dayStart(settings, now).getTime() + DAY + 10 * 3_600_000);
  if (all.some(q => q.status === 'sent')) return { sent: null, next: tomorrow };
  const today = dayStart(settings, now);
  const sentBefore = all.some(q => q.sent_at && new Date(q.sent_at) < today);
  const sentToday = all.filter(q => q.sent_at && new Date(q.sent_at) >= today).length;
  const limit = sentBefore ? config.owner_interview_daily_limit : config.owner_interview_first_batch;
  const queue = all.filter(q => q.status === 'open' && (!q.next_at || new Date(q.next_at) <= now))
    .sort((a, b) => (a.priority === b.priority ? 0 : a.priority === 'launch' ? -1 : 1) || a.created_at.localeCompare(b.created_at));
  const next = queue[0];
  if (!next || sentToday >= limit) return { sent: null, next: next ? tomorrow : null };
  const text = renderText(settings, 'owner.interview_question', lang(settings), { question: next.question, left: queue.length });
  const out = await enqueueMessage(db, tenantId, provider, { session: instance.data.session_name, chatId: destination, text }, { kind: 'owner_notice', dedupeKey: `interview:${next.id}:${next.postponed_count}` });
  if (!out.id) throw new Error('Interview question not delivered');
  check((await db.from('owner_questions').update({ status: 'sent', sent_at: now.toISOString(), owner_message_ids: [...next.owner_message_ids, out.id] }).eq('id', next.id)).error, 'Owner question update failed');
  return { sent: next.id, next: tomorrow };
}

const normalize = (text: string) => text.trim().toLowerCase().replace(/[.!…]+$/g, '').replace(/ё/g, 'е');
export const isPostpone = (text: string) => INTERVIEW_POSTPONE_WORDS.includes(normalize(text));

/** Which question an owner message answers: by quote, else the only question out when no client waits. */
export async function questionForReply(db: DatabaseClient, tenantId: string, quoted: string | null): Promise<OwnerQuestion | null> {
  const select = 'id,question,priority,source,topic,status,postponed_count,next_at,sent_at,owner_message_ids';
  if (quoted) {
    const keys = [replyId(quoted), quoted, ...await outboundIdsForProviderId(db, tenantId, quoted)];
    for (const key of keys) {
      const r = await db.from('owner_questions').select(select).eq('tenant_id', tenantId).contains('owner_message_ids', [key]).limit(1);
      check(r.error, 'Owner questions unavailable');
      if (r.data?.[0]) return r.data[0] as unknown as OwnerQuestion;
    }
    return null;
  }
  const sent = await db.from('owner_questions').select(select).eq('tenant_id', tenantId).eq('status', 'sent');
  check(sent.error, 'Owner questions unavailable');
  const waiting = await db.from('escalations').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).in('status', ['pending', 'reminding']);
  check(waiting.error, 'Escalations unavailable');
  return (sent.data ?? []).length === 1 && (waiting.count ?? 0) === 0 ? sent.data![0] as unknown as OwnerQuestion : null;
}

export interface AnswerDeps { taskAI?: AIProvider | null; embedder?: EmbeddingProvider | null }
/**
 * An answer (WhatsApp text/voice or the cabinet): postpone words put the question off (twice → cabinet only);
 * otherwise the answer becomes owner facts (extraction, or the answer itself when nothing is extracted).
 */
export async function answerOwnerQuestion(db: DatabaseClient, tenantId: string, question: OwnerQuestion, answer: string, via: 'whatsapp' | 'cabinet', deps: AnswerDeps = {}, now = new Date()):
  Promise<{ status: 'postponed' | 'cabinet_only' | 'answered'; facts: string[] }> {
  const settings = await loadOwnerSettings(db, tenantId), config = behavior(settings);
  if (isPostpone(answer)) {
    const count = question.postponed_count + 1;
    const status = count >= 2 ? 'cabinet_only' : 'open';
    check((await db.from('owner_questions').update({ status, postponed_count: count, next_at: new Date(dayStart(settings, now).getTime() + DAY).toISOString() }).eq('id', question.id)).error, 'Owner question update failed');
    return { status: status === 'open' ? 'postponed' : 'cabinet_only', facts: [] };
  }
  const reservation = await reserveKnowledgeIndex(tenantId, config.knowledge_indexing_hourly_limit, config.knowledge_indexing_daily_limit, now);
  const title = `${via === 'whatsapp' ? 'Ответ владельца в WhatsApp' : 'Ответ владельца в кабинете'}, ${now.toISOString().slice(0, 10)}`;
  const text = `Вопрос: ${question.question}\nОтвет: ${answer.trim()}`.slice(0, 20_000);
  const source = await db.from('knowledge_sources').insert({ tenant_id: tenantId, kind: 'owner_answer', title, original_text: text, status: 'ready' }).select('id').single();
  check(source.error || !source.data, 'Knowledge source save failed');
  const sourceId = String(source.data!.id);
  let facts: string[] = [];
  const taskAI = meterAI(db, tenantId, deps.taskAI === undefined ? createTaskAIProvider() : deps.taskAI, { purpose: 'owner_interview', billable_message: false });
  const embedder = deps.embedder === undefined ? createEmbeddingProvider() : deps.embedder;
  if (taskAI && reservation.allowed) {
    try {
      const existing = (await activeFacts(db, tenantId)).map(f => ({ id: f.id, topic: f.topic, text: f.text }));
      const extraction = await extractFacts(taskAI, text, existing, config.extraction_chunk_chars, title);
      // The question line is not the owner's statement: only facts quoting the answer are kept.
      extraction.facts = extraction.facts.filter(f => quoteInSource(f.quote, answer));
      await saveExtraction(db, tenantId, sourceId, extraction, { status: 'active', createdBy: 'owner', embedder, duplicateThreshold: config.fact_duplicate_threshold });
      facts = extraction.facts.map(f => f.text);
    } catch { console.warn('owner_interview_extraction_failed', { tenantId }); }
  }
  if (!facts.length) facts = [(await addOwnerFact(db, tenantId, question.topic ?? 'other', answer.trim().slice(0, 500), embedder, { kind: 'owner_answer', title })).text];
  check((await db.from('owner_questions').update({ status: 'answered', answered_at: now.toISOString(), answer_source_id: sourceId }).eq('id', question.id)).error, 'Owner question update failed');
  return { status: 'answered', facts };
}

/**
 * Owner channel hook (before the "reply with a quote" hint): an answer to an interview question.
 * Returns true when the message was taken as such.
 */
export async function handleInterviewReply(db: DatabaseClient, provider: WhatsAppProvider, tenantId: string, session: string, from: string, text: string, quoted: string | null, settings: OwnerSettings, deps: AnswerDeps = {}, now = new Date()): Promise<boolean> {
  if (!isBusinessOwner(from, settings)) return false;
  const question = await questionForReply(db, tenantId, quoted);
  if (!question || !text.trim()) return false;
  const result = await answerOwnerQuestion(db, tenantId, question, text, 'whatsapp', deps, now);
  const language = lang(settings);
  const reply = result.status === 'answered' ? renderText(settings, 'owner.interview_recorded', language, { facts: result.facts.join('; ').slice(0, 900) }) : renderText(settings, 'owner.interview_postponed', language);
  const out = await enqueueMessage(db, tenantId, provider, { session, chatId: from, text: reply }, { kind: 'owner_notice', dedupeKey: `interview-reply:${question.id}:${now.getTime()}` });
  // A correction may quote "Записала": it points at the same question.
  if (out.id && result.status === 'answered') check((await db.from('owner_questions').update({ owner_message_ids: [...question.owner_message_ids, out.id] }).eq('id', question.id)).error, 'Owner question update failed');
  await ensureInterviewJob(db, tenantId, now);
  return true;
}

/** Cards in the cabinet: open, sent and cabinet-only questions. */
export async function ownerQuestionCards(db: DatabaseClient, tenantId: string) {
  const r = await db.from('owner_questions').select('id,question,priority,topic,status,postponed_count').eq('tenant_id', tenantId).in('status', ['open', 'sent', 'cabinet_only']).order('created_at', { ascending: true });
  check(r.error, 'Owner questions unavailable');
  return (r.data ?? []).sort((a, b) => (a.priority === b.priority ? 0 : a.priority === 'launch' ? -1 : 1));
}
