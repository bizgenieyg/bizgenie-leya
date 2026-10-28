import type { DatabaseClient } from '../db/supabase.js';
import type { AIProvider } from '../providers/ai/ai-provider.interface.js';
import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { behavior } from './runtime-settings.service.js';
import { hasOwnerContact, loadOwnerSettings, type OwnerSettings } from './owner-settings.service.js';
import { isWithinQuietHours } from './escalation.service.js';
import { renderText } from './templates.service.js';
import { activeFacts, factsMarkdown } from './business-facts.service.js';
import { meterAI } from './metered-providers.js';
import { createAIProvider } from '../providers/ai/index.js';
import { enqueueMessage } from '../workers/outbound-queue.js';
import { formatPhone } from '../utils/whatsapp-id.js';
import { allowedRecipient } from '../utils/incoming-policy.js';
import { zonedDateTimeFormat } from '../utils/time-zone.js';
import { DEFAULT_TIME_ZONE } from '../config/time-zones.js';
import { DAILY_REVIEW_PROMPT } from '../config/instructions.js';

/**
 * Z12 (as chef-bot dailyReport.js): at daily_report_time of the tenant, about yesterday — one line per client
 * (✅ request / ❌ lost + reason / 💬 in progress / ℹ️ info) under the counts, to the «Отчёты» group. No dialogs — nothing
 * is sent. The same model call (one per tenant) finds doubtful replies for the operator (quality_findings).
 */
const check = (error: unknown) => { if (error) throw new Error('Daily report persistence failed'); };
const OUTCOMES = ['request', 'lost', 'in_progress', 'info_only'] as const;
type Outcome = (typeof OUTCOMES)[number];
const ICONS: Record<Outcome, string> = { request: '✅', lost: '❌', in_progress: '💬', info_only: 'ℹ️' };
const REASONS = ['price', 'date', 'missing', 'silent', 'other'] as const;
const FINDING_KINDS = ['price_not_in_facts', 'term_not_in_facts', 'promise_for_owner', 'contradicts_facts', 'other'];
export interface ReviewedDialog { id: string; summary: string; outcome: Outcome; reason: (typeof REASONS)[number] | null }
export interface Finding { id: string; kind: string; reply_excerpt: string; note: string }

const localParts = (now: Date, zone: string) => Object.fromEntries(zonedDateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, zone)
  .formatToParts(now).map(p => [p.type, p.value])) as Record<string, string>;
export const localDay = (at: Date, zone: string) => { const p = localParts(at, zone); return `${p.year}-${p.month}-${p.day}`; };
/** The local day before `now` and whether the report time has come (HH:MM of the tenant). */
export function reportDue(settings: OwnerSettings, now: Date): { reportDate: string } | null {
  const config = behavior(settings), zone = settings.time_zone ?? DEFAULT_TIME_ZONE, p = localParts(now, zone);
  if (!config.daily_report_enabled || `${p.hour}:${p.minute}` < String(config.daily_report_time)) return null;
  const yesterday = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) - 1));
  return { reportDate: yesterday.toISOString().slice(0, 10) };
}

/** The review answer: every dialog id once (unknown ids dropped, a missing one → info only), findings of known dialogs. */
export function parseReview(raw: string, ids: string[]): { dialogs: ReviewedDialog[]; findings: Finding[] } {
  let value: Record<string, unknown> = {};
  try { const parsed: unknown = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed as Record<string, unknown>; } catch { /* below: defaults */ }
  const list = (key: string) => Array.isArray(value[key]) ? (value[key] as unknown[]).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];
  const byId = new Map(list('dialogs').map(d => [String(d.id), d]));
  const dialogs = ids.map(id => {
    const d = byId.get(id) ?? {};
    const outcome = OUTCOMES.includes(d.outcome as Outcome) ? d.outcome as Outcome : 'info_only';
    const reason = outcome === 'lost' ? (REASONS.includes(d.reason as never) ? d.reason as ReviewedDialog['reason'] : 'other') : null;
    return { id, summary: typeof d.summary === 'string' ? d.summary.replace(/[<>{}]/g, '').slice(0, 120) : '—', outcome, reason };
  });
  const known = new Set(ids);
  const findings = list('findings').filter(f => known.has(String(f.id))).slice(0, 20).map(f => ({ id: String(f.id), kind: FINDING_KINDS.includes(String(f.kind)) ? String(f.kind) : 'other',
    reply_excerpt: typeof f.reply_excerpt === 'string' ? f.reply_excerpt.slice(0, 500) : '', note: typeof f.note === 'string' ? f.note.slice(0, 500) : '' }));
  return { dialogs, findings };
}

/** One tenant: claims the day (one report per day even after a restart), reviews, sends, keeps the findings. */
export async function runTenantDailyReport(db: DatabaseClient, tenantId: string, session: string, provider: WhatsAppProvider, now = new Date(), ai?: AIProvider | null): Promise<'sent' | 'empty' | 'skipped'> {
  const settings = await loadOwnerSettings(db, tenantId), config = behavior(settings), zone = settings.time_zone ?? DEFAULT_TIME_ZONE;
  const due = reportDue(settings, now);
  if (!due || isWithinQuietHours(settings, now) || !hasOwnerContact(settings)) return 'skipped';
  const claimed = await db.from('owner_daily_reports').insert({ tenant_id: tenantId, report_date: due.reportDate }).select('tenant_id');
  if (claimed.error?.code === '23505') return 'skipped';
  check(claimed.error);
  // Messages of the report day (two days back covers any zone), grouped by dialog.
  const rows = await db.from('messages').select('conversation_id,from_me,body,created_at').eq('tenant_id', tenantId)
    .gte('created_at', new Date(now.getTime() - 72 * 3_600_000).toISOString()).order('created_at', { ascending: true }).limit(5000);check(rows.error);
  const dialogs = new Map<string, Array<{ fromMe: boolean; text: string }>>();
  for (const row of rows.data ?? []) {
    if (typeof row.body !== 'string' || !row.body.trim() || localDay(new Date(String(row.created_at)), zone) !== due.reportDate) continue;
    const list = dialogs.get(String(row.conversation_id)) ?? [];
    list.push({ fromMe: row.from_me === true, text: row.body.slice(0, 600) });
    dialogs.set(String(row.conversation_id), list);
  }
  // A dialog is a client's: at least one message from the client that day.
  const ids = [...dialogs.entries()].filter(([, list]) => list.some(m => !m.fromMe)).map(([id]) => id).slice(0, config.daily_report_max_dialogs);
  if (!ids.length) { check((await db.from('owner_daily_reports').update({ conversations: 0 }).eq('tenant_id', tenantId).eq('report_date', due.reportDate)).error); return 'empty'; }
  const facts = factsMarkdown(await activeFacts(db, tenantId), null);
  const transcript = ids.map(id => `--- id: ${id}\n${dialogs.get(id)!.slice(-config.daily_report_dialog_messages).map(m => `${m.fromMe ? 'Ассистент' : 'Клиент'}: ${m.text}`).join('\n')}`).join('\n\n');
  const model = ai === undefined ? meterAI(db, tenantId, createAIProvider(), { purpose: 'daily_review' }) : ai;
  let raw = '';
  try { raw = model ? (await model.generateReply({ systemPrompt: DAILY_REVIEW_PROMPT, userMessage: `ФАКТЫ:\n${facts || '(нет)'}\n\nДИАЛОГИ:\n${transcript}`, generation: { maxOutputTokens: 8192 } })).text : ''; }
  catch { console.warn('daily_review_unavailable', { tenantId }); }
  const review = parseReview(raw, ids);
  // Names for the owner (their own clients): the name the client gave, else the WhatsApp name, else the phone.
  const conversations = await db.from('conversations').select('id,client_id').eq('tenant_id', tenantId).in('id', ids);check(conversations.error);
  const clientIds = (conversations.data ?? []).map(c => String(c.client_id));
  const clients = clientIds.length ? await db.from('clients').select('id,preferred_name,name,phone').eq('tenant_id', tenantId).in('id', clientIds) : { data: [], error: null };check(clients.error);
  const clientOf = new Map((conversations.data ?? []).map(c => [String(c.id), (clients.data ?? []).find(x => String(x.id) === String(c.client_id))]));
  const language = config.owner_language;
  const counts = { request: 0, lost: 0, in_progress: 0, info_only: 0 };
  const lines = review.dialogs.map(d => {
    counts[d.outcome]++;
    const c = clientOf.get(d.id);
    const name = String(c?.preferred_name || c?.name || formatPhone(c?.phone) || '—');
    const reason = d.reason ? ` (${renderText(settings, `owner.daily_reason_${d.reason}`, language)})` : '';
    return renderText(settings, 'owner.daily_report_line', language, { icon: ICONS[d.outcome], name, summary: d.summary, reason });
  });
  const date = zonedDateTimeFormat('ru', { day: '2-digit', month: '2-digit', year: 'numeric' }, 'UTC').format(new Date(`${due.reportDate}T12:00:00Z`));
  const text = renderText(settings, 'owner.daily_report', language, { date, total: String(ids.length), request: String(counts.request), in_progress: String(counts.in_progress), lost: String(counts.lost), info: String(counts.info_only), lines: lines.join('\n') });
  if (review.findings.length) check((await db.from('quality_findings').insert(review.findings.map(f => ({ tenant_id: tenantId, conversation_id: f.id, report_date: due.reportDate, kind: f.kind, reply_excerpt: f.reply_excerpt || null, note: f.note || null })))).error);
  const { ownerChat, ownerChatAllowed } = await import('./owner-channels.service.js');
  const to = await ownerChat(db, provider, tenantId, session, settings, 'reports');
  if (!ownerChatAllowed(to)) { console.warn('daily_report_channel_unavailable', { tenantId }); return 'skipped'; }
  await enqueueMessage(db, tenantId, provider, { session, chatId: to, text }, { kind: 'summary', dedupeKey: `daily-report:${tenantId}:${due.reportDate}` });
  check((await db.from('owner_daily_reports').update({ conversations: ids.length, sent_at: new Date().toISOString() }).eq('tenant_id', tenantId).eq('report_date', due.reportDate)).error);
  return 'sent';
}

async function systemValue(db: DatabaseClient, key: string): Promise<string> {
  const row = await db.from('system_config').select('value').eq('key', key).maybeSingle();check(row.error);
  return typeof row.data?.value === 'string' ? row.data.value.trim() : '';
}
/** The operator's message: unreported findings of all tenants, at most one a day; no number or session — table only. */
export async function runPlatformQualityReport(db: DatabaseClient, provider: WhatsAppProvider, now = new Date()): Promise<boolean> {
  const number = (await systemValue(db, 'platform_report_number')).replace(/\D/g, ''), tenant = await systemValue(db, 'platform_report_tenant');
  if (!number || !tenant) return false;
  const recent = await db.from('quality_findings').select('id').gte('reported_at', new Date(now.getTime() - 20 * 3_600_000).toISOString()).limit(1);check(recent.error);
  if (recent.data?.length) return false;
  const open = await db.from('quality_findings').select('id,tenant_id,kind,reply_excerpt,note,report_date').is('reported_at', null).order('created_at', { ascending: true }).limit(50);check(open.error);
  if (!open.data?.length) return false;
  const instance = await db.from('whatsapp_instances').select('session_name').eq('tenant_id', tenant).maybeSingle();check(instance.error);
  const chatId = `${number}@c.us`;
  if (!instance.data?.session_name || !allowedRecipient(chatId)) return false;
  const tenantIds = [...new Set(open.data.map(f => String(f.tenant_id)))];
  const tenants = await db.from('tenants').select('id,name').in('id', tenantIds);check(tenants.error);
  const nameOf = new Map((tenants.data ?? []).map(t => [String(t.id), String(t.name ?? '')]));
  const lines = open.data.map(f => `• ${nameOf.get(String(f.tenant_id)) || '—'} — ${f.kind}: «${String(f.reply_excerpt ?? '').slice(0, 200)}»${f.note ? ` (${String(f.note).slice(0, 200)})` : ''}`);
  const date = String(open.data.at(-1)!.report_date instanceof Date ? (open.data.at(-1)!.report_date as Date).toISOString() : open.data.at(-1)!.report_date).slice(0, 10);
  const settings = await loadOwnerSettings(db, tenant);
  const text = renderText(settings, 'operator.quality_report', 'ru', { date, count: String(open.data.length), lines: lines.join('\n') });
  await enqueueMessage(db, tenant, provider, { session: String(instance.data.session_name), chatId, text }, { kind: 'owner_notice', dedupeKey: `quality-report:${date}:${open.data[0]!.id}` });
  check((await db.from('quality_findings').update({ reported_at: now.toISOString() }).in('id', open.data.map(f => f.id))).error);
  return true;
}

/** The hourly job: each tenant's report when its time has come, then the operator's message. */
export async function runDailyReports(db: DatabaseClient, providerFor: () => WhatsAppProvider, now = new Date()): Promise<void> {
  const instances = await db.from('whatsapp_instances').select('tenant_id,session_name');check(instances.error);
  for (const row of instances.data ?? []) {
    if (!row.session_name) continue;
    try { await runTenantDailyReport(db, String(row.tenant_id), String(row.session_name), providerFor(), now); }
    catch { console.error('daily_report_failed', { tenantId: row.tenant_id }); }
  }
  try { await runPlatformQualityReport(db, providerFor(), now); } catch { console.error('quality_report_failed'); }
}
