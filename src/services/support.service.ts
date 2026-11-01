import type { DatabaseClient } from '../db/supabase.js';
import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { allowedRecipient } from '../utils/incoming-policy.js';
import { normalizeWebhookMessage } from '../utils/webhook-message.js';
import { extractMessageId } from '../providers/whatsapp/waha.provider.js';
import { enqueueMessage, outboundIdsForProviderId } from '../workers/outbound-queue.js';
import { replyId } from '../utils/assistant-text.js';
import { insertProposal, type Proposal, type Step } from './owner-rules.service.js';
import { reopen } from './owner-chat.service.js';
import { loadOwnerSettings, type OwnerSettings } from './owner-settings.service.js';
import { isOwnQueuedSend } from './outgoing-owner.service.js';
import { behavior } from './runtime-settings.service.js';
import { renderText } from './templates.service.js';
import { logSystemEvent } from './logging.service.js';
import { resolveClientPhone } from './client-phone.service.js';

/**
 * Z15: owners' requests to BizGenie. «Передать в BizGenie? Да / Нет» → a row in support_requests and a message to the
 * operator's group «BizGenie · Поддержка» (the platform tenant's session, the operator's personal number as the
 * participant, created at the first request). The operator answers by a quote → «Ответ BizGenie: «…»» in the owner's
 * «Нужен ответ»; the owner's quote of that answer goes back to the same request. The assistant never solves the problem
 * itself and promises no dates.
 */
const check = (error: unknown, message: string) => { if (error) throw new Error(message); };
/** The request whose messages (column) include one of the keys — each key in turn, like the escalation lookups. */
async function requestBy<T>(db: DatabaseClient, column: 'operator_message_ids' | 'owner_message_ids', keys: string[], columns: string, tenantId?: string): Promise<T | undefined> {
  for (const key of keys) {
    let q = db.from('support_requests').select(columns).contains(column, [key]);
    if (tenantId) q = q.eq('tenant_id', tenantId);
    const r = await q.limit(1);check(r.error, 'Support request lookup failed');
    if (r.data?.[0]) return r.data[0] as T;
  }
  return undefined;
}
const lang = (settings: OwnerSettings) => { const l = behavior(settings).owner_language; return l === 'he' || l === 'en' ? l : 'ru'; };
export type SupportDraft = { text: string; quotedText: string | null; conversationId: string | null };

async function systemValue(db: DatabaseClient, key: string): Promise<string> {
  const row = await db.from('system_config').select('value').eq('key', key).maybeSingle();check(row.error, 'System config lookup failed');
  return typeof row.data?.value === 'string' ? row.data.value.trim() : '';
}
async function platform(db: DatabaseClient): Promise<{ tenant: string; session: string; number: string } | null> {
  const tenant = await systemValue(db, 'platform_report_tenant'), number = (await systemValue(db, 'platform_report_number')).replace(/\D/g, '');
  if (!tenant || !number) return null;
  const instance = await db.from('whatsapp_instances').select('session_name').eq('tenant_id', tenant).maybeSingle();check(instance.error, 'Instance lookup failed');
  return instance.data?.session_name ? { tenant, session: String(instance.data.session_name), number } : null;
}

/** «Передать в BizGenie: «…»? Да / Нет» — the request waits in a proposal until «Да». */
export async function proposeSupport(db: DatabaseClient, tenantId: string, settings: OwnerSettings, draft: SupportDraft): Promise<Step> {
  const text = draft.text.trim().slice(0, 2000);
  const p = await insertProposal(db, tenantId, { action: 'support', status: 'pending', source: 'whatsapp', payload: { text, quoted_text: draft.quotedText?.slice(0, 2000) ?? null, conversation_id: draft.conversationId } });
  return { reply: renderText(settings, 'owner.support_offer', lang(settings), { text }), proposal: p, kind: 'support' };
}

// One support group: two first requests must not create two groups (leya-api is a single process).
let creating: Promise<string | null> | null = null;
async function supportGroup(db: DatabaseClient, provider: WhatsAppProvider, p: { tenant: string; session: string; number: string }): Promise<string | null> {
  const stored = await systemValue(db, 'support_group_chat');
  if (stored) return stored;
  if (creating) return creating;
  creating = (async () => {
    const again = await systemValue(db, 'support_group_chat');
    if (again) return again;
    const operator = `${p.number}@c.us`;
    if (!provider.createGroup || !allowedRecipient(operator)) return null;
    const settings = await loadOwnerSettings(db, p.tenant);
    const chatId = await provider.createGroup(p.session, { name: renderText(settings, 'operator.support_group', 'ru'), participants: [operator] });
    check((await db.from('system_config').upsert({ key: 'support_group_chat', value: chatId, updated_at: new Date().toISOString() }, { onConflict: 'key' })).error, 'System config save failed');
    await logSystemEvent(db, { tenantId: p.tenant, level: 'info', event: 'support_group_created', details: {} });
    return chatId;
  })();
  try { return await creating; } finally { creating = null; }
}

/** The request goes to the operator; false — no operator group (not configured or not created). */
async function toOperator(db: DatabaseClient, provider: WhatsAppProvider, request: { id: string; tenant_id: string; text: string; quoted_text: string | null }, dedupe: string): Promise<boolean> {
  const p = await platform(db);
  if (!p) return false;
  const group = await supportGroup(db, provider, p);
  if (!group) return false;
  const tenant = await db.from('tenants').select('business_name,name').eq('id', request.tenant_id).maybeSingle();check(tenant.error, 'Tenant lookup failed');
  const settings = await loadOwnerSettings(db, p.tenant);
  const context = request.quoted_text ? '\n' + renderText(settings, 'operator.support_context', 'ru', { quoted: request.quoted_text.slice(0, 300) }) : '';
  const text = renderText(settings, 'operator.support_request', 'ru', { business: String(tenant.data?.business_name || '—'), owner: String(tenant.data?.name || '—'), text: request.text, context });
  const sent = await enqueueMessage(db, p.tenant, provider, { session: p.session, chatId: group, text }, { kind: 'owner_notice', dedupeKey: dedupe });
  const row = await db.from('support_requests').select('operator_message_ids').eq('id', request.id).single();check(row.error, 'Support request lookup failed');
  check((await db.from('support_requests').update({ operator_message_ids: [...(row.data!.operator_message_ids as string[]), sent.id], status: 'new' }).eq('id', request.id)).error, 'Support request update failed');
  return true;
}

/** «Да»: the request is saved and goes to the operator. Returns the line for the owner. */
export async function submitSupport(db: DatabaseClient, provider: WhatsAppProvider, tenantId: string, settings: OwnerSettings, p: Proposal): Promise<string> {
  const claimed = await db.from('owner_rule_proposals').update({ status: 'applied', decided_at: new Date().toISOString() }).eq('id', p.id).eq('status', 'pending').select('id');
  check(claimed.error, 'Proposal update failed');
  if (!claimed.data?.length) return renderText(settings, 'owner.support_sent', lang(settings));
  const payload = p.payload ?? {};
  const created = await db.from('support_requests').insert({ tenant_id: tenantId, text: String(payload.text ?? '').slice(0, 2000) || '—', quoted_text: typeof payload.quoted_text === 'string' ? payload.quoted_text : null,
    conversation_id: typeof payload.conversation_id === 'string' ? payload.conversation_id : null }).select('id,tenant_id,text,quoted_text').single();
  if (created.error || !created.data) { await reopen(db, p.id); throw new Error('Support request save failed'); }
  const request = created.data as { id: string; tenant_id: string; text: string; quoted_text: string | null };
  let ok = false;
  try { ok = await toOperator(db, provider, request, `support:${request.id}`); } catch { console.error('support_request_send_failed', { tenantId }); }
  // Z15 review: not delivered to the operator — the request is not kept as sent; the proposal waits again for «Да».
  if (!ok) { check((await db.from('support_requests').delete().eq('id', request.id)).error, 'Support request delete failed'); await reopen(db, p.id); }
  return renderText(settings, ok ? 'owner.support_sent' : 'owner.support_unavailable', lang(settings));
}

/** The owner quoted «Ответ BizGenie: …»: the text goes to the same request and to the operator again. Null — not that. */
export async function ownerSupportFollowUp(db: DatabaseClient, provider: WhatsAppProvider, tenantId: string, settings: OwnerSettings, keys: string[], text: string, inboundId: string | null): Promise<string | null> {
  if (!keys.length) return null;
  const request = await requestBy<{ id: string; tenant_id: string }>(db, 'owner_message_ids', keys, 'id,tenant_id', tenantId);
  if (!request) return null;
  let ok = false;
  try { ok = await toOperator(db, provider, { id: request.id, tenant_id: tenantId, text: text.trim().slice(0, 2000), quoted_text: null }, `support:${request.id}:owner:${inboundId ?? Date.now()}`); }
  catch { console.error('support_request_send_failed', { tenantId }); }
  return renderText(settings, ok ? 'owner.support_sent' : 'owner.support_unavailable', lang(settings));
}

/**
 * A message in the operator's support group (platform tenant). A quote of a request → «Ответ BizGenie: «…»» in that
 * owner's «Нужен ответ», status answered. True when the message belonged to the support group (handled or not).
 */
export async function handleSupportGroupMessage(db: DatabaseClient, provider: WhatsAppProvider, tenantId: string, body: Record<string, unknown>): Promise<boolean> {
  const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const payload = record(body.payload), info = record(record(payload._data).Info);
  const chat = [info.Chat, payload.from, payload.to].find(value => typeof value === 'string' && value.endsWith('@g.us')) as string | undefined;
  if (!chat) return false;
  const p = await platform(db);
  if (!p || p.tenant !== tenantId || chat !== await systemValue(db, 'support_group_chat')) return false;
  const text = typeof payload.body === 'string' ? payload.body.trim() : '';
  const fromMe = payload.fromMe === true || info.IsFromMe === true;
  const id = extractMessageId(payload.id) || '';
  // The assistant's own sends (the requests themselves) are not answers.
  if (!text || (fromMe && (payload.source === 'api' || await isOwnQueuedSend(db, tenantId, id, [chat], text, new Date())))) return true;
  // Z15 review: only the operator answers for BizGenie — the operator's number (a @lid sender resolved to its phone), or
  // the platform account itself. Anyone else added to the group is ignored.
  if (!fromMe) {
    const sender = [payload.participant, info.Sender].find(value => typeof value === 'string' && /^\d+@(c\.us|s\.whatsapp\.net|lid)$/.test(value)) as string | undefined;
    const phone = sender ? await resolveClientPhone(provider, p.session, sender.replace(/@s\.whatsapp\.net$/, '@c.us'), body, behavior(await loadOwnerSettings(db, p.tenant)).lid_lookup_timeout_seconds) : null;
    if (phone !== p.number) { console.warn('support_answer_not_operator', { tenantId }); return true; }
  }
  const normalized = normalizeWebhookMessage(body);
  const quoted = normalized.kind === 'message' ? normalized.replyToId : null;
  if (!quoted) return true;
  const keys = [replyId(quoted), quoted, ...await outboundIdsForProviderId(db, tenantId, quoted)];
  const request = await requestBy<{ id: string; tenant_id: string; owner_message_ids: string[] }>(db, 'operator_message_ids', keys, 'id,tenant_id,owner_message_ids');
  if (!request) return true;
  const settings = await loadOwnerSettings(db, request.tenant_id);
  const instance = await db.from('whatsapp_instances').select('session_name').eq('tenant_id', request.tenant_id).maybeSingle();check(instance.error, 'Instance lookup failed');
  const session = typeof instance.data?.session_name === 'string' ? instance.data.session_name : '';
  const { ownerChat, ownerChatAllowed } = await import('./owner-channels.service.js');
  const to = session ? await ownerChat(db, provider, request.tenant_id, session, settings, 'needs_answer') : null;
  if (!ownerChatAllowed(to)) { console.warn('support_answer_owner_unavailable', { tenantId: request.tenant_id }); return true; }
  const sent = await enqueueMessage(db, request.tenant_id, provider, { session, chatId: to, text: renderText(settings, 'owner.support_answer', lang(settings), { text }) }, { kind: 'owner_notice', dedupeKey: `support:${request.id}:answer:${id || Date.now()}` });
  check((await db.from('support_requests').update({ status: 'answered', answer: text.slice(0, 4000), answered_at: new Date().toISOString(), owner_message_ids: [...request.owner_message_ids, sent.id] }).eq('id', request.id)).error, 'Support request update failed');
  return true;
}
