import { renderText,languageOf } from '../services/templates.service.js';
import { registry,agentContext } from '../agents/index.js';
import { behavior } from '../services/runtime-settings.service.js';
import { notifyUsageFailure } from '../services/usage-notifications.service.js';
import { randomUUID } from 'node:crypto';
import { createAIProvider } from '../providers/ai/index.js';
import { meterAI, meterWhatsApp } from '../services/metered-providers.js';
import { deliverUsageNotices,limitClientText } from '../services/usage-notifications.service.js';
import { filterIncoming, incomingDiagnostics, logRejectedIncoming, ownerIdentityField, readSessionIdentity } from "../utils/incoming-policy.js";
import type { AIProvider } from "../providers/ai/ai-provider.interface.js";
import { generateKnowledgeReply } from "../services/ai-fallback.service.js";
import { supabase, type DatabaseClient } from "../db/supabase.js";
import { createWhatsAppProvider } from "../providers/whatsapp/index.js";
import type { WhatsAppProvider } from "../providers/whatsapp/whatsapp-provider.interface.js";
import { normalizeWebhookMessage, webhookEventType } from "../utils/webhook-message.js";
import { isStatusBroadcast, senderKey } from "../utils/whatsapp-id.js";
import { loadContext } from "../services/context.service.js";
import {
  createEscalation, handleOwnerMessage, conversationPaused,
} from "../services/owner-workflow.service.js";
import { loadOwnerSettings } from "../services/owner-settings.service.js";
import { clientTimeZoneCommand } from "../utils/time-zone.js";
import { isWithinQuietHours, nextQuietHoursEnd } from "../services/escalation.service.js";
import { waitingText } from "../utils/assistant-text.js";
import { clientText } from "../utils/assistant-text.js";
import { findExactKnowledgeAnswer } from "../services/knowledge.service.js";
import { logSystemEvent, recordAgentAction } from "../services/logging.service.js";
import {
  findOrCreateClient,
  findOrCreateConversation,
  getTenantRouting,
  isTenantServiceable,
} from "../services/tenant.service.js";
import { admitUsage, recordUsageEvent } from "../services/usage.service.js";

/**
 * Process one already-authenticated webhook body for `tenantId`.
 *
 * Resolves tenant/client/conversation, persists the inbound message with its raw
 * payload, then either answers with an exact FAQ match or escalates to the owner.
 * Only inbound private customer text passes the early recipient policy.
 */
export async function handleWebhookEvent(
  tenantId: string,
  body: Record<string, unknown>,
  db: DatabaseClient = supabase,
  whatsapp?: WhatsAppProvider,
  ai?: AIProvider | null,
  voiceAdmission?: {key:string;seconds:number;unavailable?:boolean|undefined;sttKey:string;sttMetadata:Record<string,unknown>},
): Promise<void> {
  const decision = filterIncoming(body);
  if (!decision.allowed) { logRejectedIncoming(decision); return; }
  const event = webhookEventType(body);
  const normalized = normalizeWebhookMessage(body);
  if (normalized.kind !== "message") {
    const invalid = normalized.kind === "invalid";
    const details = { event, ...(invalid ? { reason: normalized.reason } : {}) };
    if (invalid) console.warn("webhook_message_skipped", details);
    await logSystemEvent(db, {
      tenantId, level: invalid ? "warn" : "info",
      event: invalid ? "webhook_invalid_message" : "webhook_ignored_event", details,
    });
    return;
  }
  const { from, text, incomingMsgId, pushName } = normalized;
  if (isStatusBroadcast(from)) return;

  const routing = await getTenantRouting(db, tenantId);
  if (!routing) {
    await logSystemEvent(db, {
      tenantId,
      level: "warn",
      event: "webhook_unknown_tenant",
      details: {},
    });
    return;
  }
  const { tenant, instance } = routing;
  const session =
    (typeof instance?.session_name === "string" && instance.session_name.trim()) ||
    (typeof body.session === "string" && body.session.trim()) ||
    "default";
  const provider = meterWhatsApp(db,tenantId,whatsapp ?? createWhatsAppProvider());
  const model = meterAI(db,tenantId,ai === undefined ? createAIProvider() : ai);

  // Prefer current session identity; an authenticated webhook also carries me.
  // Failure to fetch it never turns an incoming message into an outgoing one.
  let me = readSessionIdentity(body.me);
  try {
    const current = readSessionIdentity((await provider.getSessionStatus(session)).me);
    me = { ...me, ...current };
  } catch {
    console.warn("webhook_session_identity_lookup_failed");
  }
  const ownerField = ownerIdentityField(from, me);
  if (ownerField) {
    logRejectedIncoming({ allowed: false, chatType: "private", event,
      reason: "owner_message", field: ownerField, value: "matched", diagnostics: incomingDiagnostics(body, me) });
    return;
  }

  if (!isTenantServiceable(tenant.status)) {
    await logSystemEvent(db, {
      tenantId,
      level: "warn",
      event: "tenant_inactive",
      details: { status: tenant.status },
    });
    return;
  }

  const settings = await loadOwnerSettings(db, tenantId);
  const usageKey=incomingMsgId || randomUUID();

  if (await handleOwnerMessage(db, provider, tenantId, session, from, text, normalized.replyToId, settings, model)) {await recordUsageEvent(db,{tenantId,eventType:'message_observed',eventKey:usageKey,metadata:{reason:'owner_control',billable:false}});return;}

  const clientPhone = senderKey(from);
  const client = await findOrCreateClient(
    db,
    tenantId,
    clientPhone,
    pushName,
  );
  const conversation = await findOrCreateConversation(db, tenantId, client.id);

  const { error: insertError } = await db.from("messages").insert({
    conversation_id: conversation.id,
    tenant_id: tenantId,
    from_me: false,
    body: text,
    msg_type: "text",
    waha_msg_id: incomingMsgId,
    raw_payload: body,
  });
  if (insertError) {
    await logSystemEvent(db, {
      tenantId,
      level: "error",
      event: "message_persist_failed",
      details: { conversation_id: conversation.id },
    });
    return;
  }

  if (settings.auto_replies_paused || await conversationPaused(db, tenantId, conversation.id)) {await recordUsageEvent(db,{tenantId,eventType:'message_observed',eventKey:usageKey,metadata:{reason:'paused',billable:false}});return;}

  const admission=voiceAdmission ? {allowed:true,duplicate:false,unavailable:voiceAdmission.unavailable} : await admitUsage(db,tenantId,usageKey);
  if(admission.duplicate)return;
  if(admission.unavailable)await notifyUsageFailure(db,tenantId,session,provider,settings);
  await deliverUsageNotices(db,tenantId,session,provider);
  if(!admission.allowed){
    await provider.sendMessage({session,chatId:from,text:limitClientText(text,settings)});
    return;
  }

  const classification:Record<string,unknown>[]=[];
  const agent=await registry.route(text,settings,ai===undefined?createAIProvider():ai,usage=>classification.push(usage));
  if(!agent)return;
  return agentContext.run({agent:agent.name},async()=>{
  for(const metadata of classification)await recordUsageEvent(db,{tenantId,eventType:'model_call',eventKey:randomUUID(),metadata:{...metadata,purpose:'intent'}});
  await recordUsageEvent(db,{tenantId,eventType:'message_received',eventKey:usageKey});
  if(voiceAdmission){
    // STT is metered immediately, then attributed to the agent selected from its transcript.
    try{for(const [type,key]of [['stt_call',voiceAdmission.sttKey],['voice_received',usageKey]]){const r=await db.from('usage_events').update({agent:agent.name}).eq('tenant_id',tenantId).eq('event_type',type).eq('event_key',key);if(r.error)console.error('usage_agent_attribution_failed');}}catch{console.error('usage_agent_attribution_failed');}
  }
  const clientZone = clientTimeZoneCommand(text);
  if (clientZone) {
    const { error } = await db.from("clients").update({ time_zone: clientZone }).eq("tenant_id", tenantId).eq("id", client.id);
    if (error) throw new Error("Client timezone update failed");
    const confirmation = renderText(settings,'client.timezone_saved',languageOf(text),{zone:clientZone});
    const now = new Date();
    const quiet = isWithinQuietHours(settings, now);
    await provider.sendMessage({ session, chatId: from, text: confirmation + (quiet ? ' ' + waitingText(text, { at: nextQuietHoursEnd(settings, now), ownerZone: settings.time_zone ?? 'UTC', clientZone },settings) : '') });
    return;
  }

  return agent.execute({answerFromKnowledge:async()=>{
  const context = await loadContext(db, tenantId);
  const result = findExactKnowledgeAnswer(text, context.knowledge);
  const clientName = client.name && client.name.trim() !== "" ? client.name : clientPhone;

  if (result.matched) {
    const sent = await provider.sendMessage({
      session,
      chatId: from,
      text: clientText(result.answer),
      ...(incomingMsgId ? { replyTo: incomingMsgId } : {}),
    });
    await db.from("messages").insert({
      conversation_id: conversation.id,
      tenant_id: tenantId,
      from_me: true,
      body: result.answer,
      msg_type: "text",
      waha_msg_id: sent.id || null,
    });
    await recordAgentAction(db, {
      tenantId,
      conversationId: conversation.id,
      actionType: "faq_answer_exact",
      input: text,
      output: result.answer,
    });
    await recordUsageEvent(db, {
      tenantId,
      eventType: "faq_answer_exact",
      metadata: { knowledge_item_id: result.knowledgeItemId },
    });
    await logSystemEvent(db, {
      tenantId,
      level: "info",
      event: "faq_answer_exact",
      details: { conversation_id: conversation.id },
    });
    return;
  }

  const generatedReply = await generateKnowledgeReply(context, text, model,agent.systemPrompt);
  if (generatedReply) {
    const sent = await provider.sendMessage({
      session, chatId: from, text: generatedReply,
      ...(incomingMsgId ? { replyTo: incomingMsgId } : {}),
    });
    await db.from("messages").insert({
      conversation_id: conversation.id, tenant_id: tenantId, from_me: true,
      body: generatedReply, msg_type: "text", waha_msg_id: sent.id || null,
    });
    await recordAgentAction(db, {
      tenantId, conversationId: conversation.id, actionType: "knowledge_ai_answer",
    });
    await recordUsageEvent(db, { tenantId, eventType: "knowledge_ai_answer" });
    return;
  }

  await createEscalation(db, provider, {
    tenant_id: tenantId, session, conversation_id: conversation.id,
    client_chat_id: from, client_name: pushName || clientName,
    question: text, inbound_id: incomingMsgId,
  }, settings, client.time_zone);
  await recordUsageEvent(db, { tenantId, eventType: "escalation_created" });
  }});
  });
}
