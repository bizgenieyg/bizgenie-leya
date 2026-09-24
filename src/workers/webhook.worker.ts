import { randomUUID } from 'node:crypto';
import { supabase, type DatabaseClient } from '../db/supabase.js';
import type { AIProvider } from '../providers/ai/ai-provider.interface.js';
import { createAIProvider } from '../providers/ai/index.js';
import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { createWhatsAppProvider } from '../providers/whatsapp/index.js';
import { loadConversationMemory } from '../services/context.service.js';
import { fetchChatHistory } from '../services/chat-history.service.js';
import { meterAI } from '../services/metered-providers.js';
import { enqueueMessage } from './outbound-queue.js';
import { notifyUsageFailure, deliverUsageNotices } from '../services/usage-notifications.service.js';
import { behavior } from '../services/runtime-settings.service.js';
import { createEscalation, handleOwnerMessage, conversationPaused } from '../services/owner-workflow.service.js';
import { loadOwnerSettings } from '../services/owner-settings.service.js';
import { logSystemEvent, recordAgentAction } from '../services/logging.service.js';
import { findOrCreateClient, findOrCreateConversation, getTenantRouting, isTenantServiceable } from '../services/tenant.service.js';
import { admitUsage, recordUsageEvent } from '../services/usage.service.js';
import { inferredLanguage, requestsNoAutomaticReplies } from '../services/client-cards.service.js';
import { processCustomerMessage, type PipelineSink } from '../services/message-pipeline.service.js';
import { withoutRepeatedIntroduction } from '../utils/assistant-text.js';
import { filterIncoming, incomingDiagnostics, logRejectedIncoming, ownerIdentityField, readSessionIdentity } from '../utils/incoming-policy.js';
import { normalizeWebhookMessage, webhookEventType } from '../utils/webhook-message.js';
import { isStatusBroadcast, senderKey } from '../utils/whatsapp-id.js';
import { sessionIdentity } from '../services/session-identity.service.js';

/** Transport and persistence boundary for an authenticated WAHA webhook. */
export async function handleWebhookEvent(tenantId: string, body: Record<string, unknown>, db: DatabaseClient = supabase,
  whatsapp?: WhatsAppProvider, ai?: AIProvider | null,
  voiceAdmission?: { key: string; seconds: number; unavailable?: boolean | undefined; sttKey: string; sttMetadata: Record<string, unknown> },
  batch?: Record<string, unknown>[], inboundEventIds?: string[]): Promise<void> {
  const decision = filterIncoming(body);
  if (!decision.allowed) { logRejectedIncoming(decision); return; }
  const event = webhookEventType(body);
  const normalized = normalizeWebhookMessage(body);
  if (normalized.kind !== 'message') {
    const invalid = normalized.kind === 'invalid';
    const details = { event, ...(invalid ? { reason: normalized.reason } : {}) };
    if (invalid) console.warn('webhook_message_skipped', details);
    await logSystemEvent(db, { tenantId, level: invalid ? 'warn' : 'info', event: invalid ? 'webhook_invalid_message' : 'webhook_ignored_event', details });
    return;
  }
  const pieces = batch?.map(item => normalizeWebhookMessage(item)).filter(item => item.kind === 'message') ?? [normalized];
  const { from, incomingMsgId, pushName } = normalized;
  const text = pieces.map(item => item.kind === 'message' ? item.text : '').filter(Boolean).join('\n');
  if (isStatusBroadcast(from)) return;
  const routing = await getTenantRouting(db, tenantId);
  if (!routing) { await logSystemEvent(db, { tenantId, level: 'warn', event: 'webhook_unknown_tenant', details: {} }); return; }
  const { tenant, instance } = routing;
  const session = (typeof instance?.session_name === 'string' && instance.session_name.trim()) ||
    (typeof body.session === 'string' && body.session.trim()) || 'default';
  const provider = whatsapp ?? createWhatsAppProvider();
  const rawAI = ai === undefined ? createAIProvider() : ai;
  const model = meterAI(db, tenantId, rawAI);
  let me = readSessionIdentity(body.me);
  try { me = { ...me, ...await sessionIdentity(provider, session, !whatsapp) }; }
  catch { console.warn('webhook_session_identity_lookup_failed'); }
  const ownerField = ownerIdentityField(from, me);
  if (ownerField) {
    logRejectedIncoming({ allowed: false, chatType: 'private', event, reason: 'owner_message', field: ownerField, value: 'matched', diagnostics: incomingDiagnostics(body, me) });
    return;
  }
  if (!isTenantServiceable(tenant.status)) {
    await logSystemEvent(db, { tenantId, level: 'warn', event: 'tenant_inactive', details: { status: tenant.status } }); return;
  }
  const settings = await loadOwnerSettings(db, tenantId);
  const usageKey = incomingMsgId || randomUUID();
  if (await handleOwnerMessage(db, provider, tenantId, session, from, text, normalized.replyToId, settings, model, incomingMsgId)) {
    await recordUsageEvent(db, { tenantId, eventType: 'message_observed', eventKey: usageKey, metadata: { reason: 'owner_control', billable: false } }); return;
  }
  const clientPhone = senderKey(from);
  const client = await findOrCreateClient(db, tenantId, clientPhone, pushName, from);
  const conversation = await findOrCreateConversation(db, tenantId, client.id);
  const optedOut = requestsNoAutomaticReplies(text);
  const clientPatch: Record<string, unknown> = {};
  if (!client.language_overridden) clientPatch.language = inferredLanguage(text);
  if (optedOut) { clientPatch.auto_reply_allowed = false; clientPatch.auto_reply_opted_out_at = new Date().toISOString(); client.auto_reply_allowed = false; }
  if (Object.keys(clientPatch).length) {
    const preference = await db.from('clients').update(clientPatch).eq('tenant_id', tenantId).eq('id', client.id);
    if (preference.error) console.error('client_preferences_update_failed', { tenantId, clientId: client.id });
  }
  const messageRows = (batch ?? [body]).map((item,index) => {
    const message = normalizeWebhookMessage(item);
    return { conversation_id: conversation.id, tenant_id: tenantId, from_me: false,
      body: message.kind === 'message' ? message.text : null, msg_type: 'text',
      waha_msg_id: message.kind === 'message' ? message.incomingMsgId : null, raw_payload: item,
      ...(inboundEventIds?.[index] ? { inbound_event_id: inboundEventIds[index] } : {}) };
  });
  for (const row of messageRows) {
    const { error: insertError } = await db.from('messages').insert(row);
    if (insertError?.code === '23505' && row.inbound_event_id) continue;
    if (insertError) {
      await logSystemEvent(db, { tenantId, level: 'error', event: 'message_persist_failed', details: { conversation_id: conversation.id } });
      if (inboundEventIds?.length) throw new Error('Message persistence failed');
      return;
    }
  }
  const config = behavior(settings);
  const memory = client.auto_reply_allowed === false ? { messages: [], introduced: false } :
    await loadConversationMemory(db, tenantId, conversation.id, config.context_message_count, config.context_retention_hours);
  const currentTexts = messageRows.filter(row => typeof row.body === 'string').length;
  if (client.auto_reply_allowed !== false && memory.messages.length <= currentTexts) {
    const history = await fetchChatHistory(provider, session, from,
      pieces.flatMap(piece => piece.kind === 'message' && piece.incomingMsgId ? [piece.incomingMsgId] : []),
      { limit: config.history_fetch_limit, maxCharacters: config.history_max_characters, timeoutSeconds: config.history_timeout_seconds });
    if (history.length) {
      memory.messages = [...history, ...memory.messages];
      if (!memory.introduced && history.some(item => item.fromMe)) {
        const marked = await db.from('conversations').update({ assistant_introduced_at: new Date().toISOString() }).eq('tenant_id', tenantId).eq('id', conversation.id).is('assistant_introduced_at', null);
        if (marked.error) console.error('history_introduced_mark_failed', { tenantId, conversationId: conversation.id });
        memory.introduced = true;
      }
    }
  }
  const sink: PipelineSink = {
    mode: 'whatsapp',
    isConversationPaused: () => conversationPaused(db, tenantId, conversation.id, settings),
    onClientOptOut: async optedOut => { if (optedOut) await db.from('conversations').update({ bot_paused: true }).eq('tenant_id', tenantId).eq('id', conversation.id); },
    admit: () => voiceAdmission ? Promise.resolve({ allowed: true, duplicate: false, ...(voiceAdmission.unavailable === undefined ? {} : { unavailable: voiceAdmission.unavailable }) }) : admitUsage(db, tenantId, usageKey),
    afterAdmission: async admission => { if (admission.unavailable) await notifyUsageFailure(db, tenantId, session, provider, settings); await deliverUsageNotices(db, tenantId, session, provider); },
    sendToClient: async reply => (await enqueueMessage(db, tenantId, provider, { session, chatId: from, text: reply },
      { kind: 'reply', dedupeKey: `inbound-reply:${inboundEventIds?.[0] ?? randomUUID()}`,
        inboundMessageIds: pieces.flatMap(piece => piece.kind === 'message' && piece.incomingMsgId ? [piece.incomingMsgId] : []) })).id || null,
    persistAssistantMessage: async (answer, id) => { await db.from('messages').insert({ conversation_id: conversation.id, tenant_id: tenantId, from_me: true, body: answer, msg_type: 'text', waha_msg_id: id }); },
    createEscalation: async language => {
      const answer = await createEscalation(db, provider, { tenant_id: tenantId, session, conversation_id: conversation.id,
        client_chat_id: from, client_name: pushName || client.name || clientPhone, question: text,
        response_language: language, inbound_id: incomingMsgId }, settings, client.time_zone);
      return answer ? withoutRepeatedIntroduction(answer, memory.introduced) : null;
    },
    markIntroduced: async () => {
      if (memory.introduced) return;
      await db.from('conversations').update({ assistant_introduced_at: new Date().toISOString() }).eq('tenant_id', tenantId).eq('id', conversation.id).is('assistant_introduced_at', null);
      memory.introduced = true;
    },
    recordUsage: (eventType, options) => recordUsageEvent(db, { tenantId, eventType, ...(options?.eventKey ? { eventKey: options.eventKey } : {}), ...(options?.metadata ? { metadata: options.metadata } : {}) }),
    recordAgentAction: async (actionType, input, output) => { await recordAgentAction(db, { tenantId, conversationId: conversation.id, actionType, ...(input ? { input } : {}), ...(output ? { output } : {}) }); },
    updateClientTimeZone: async zone => { const { error } = await db.from('clients').update({ time_zone: zone }).eq('tenant_id', tenantId).eq('id', client.id); if (error) throw new Error('Client timezone update failed'); },
    incrementReceptionCounter: async () => { const counted = await db.from('conversations').update({ reception_message_count: Number(conversation.reception_message_count ?? 0) + 1 }).eq('tenant_id', tenantId).eq('id', conversation.id); if (counted.error) console.error('reception_counter_update_failed', { tenantId, conversationId: conversation.id }); },
    attributeVoice: voiceAdmission ? async agent => {
      try { for (const [type, key] of [['stt_call', voiceAdmission.sttKey], ['voice_received', usageKey]]) {
        const updated = await db.from('usage_events').update({ agent }).eq('tenant_id', tenantId).eq('event_type', type).eq('event_key', key);
        if (updated.error) console.error('usage_agent_attribution_failed');
      } } catch { console.error('usage_agent_attribution_failed'); }
    } : undefined,
  };
  await processCustomerMessage({ db, tenantId, text, client, conversation, memory, settings, ai: rawAI, model, usageKey, optedOut, sink });
}
