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
import { generateKnowledgeReply,generateReceptionReply } from "../services/ai-fallback.service.js";
import { supabase, type DatabaseClient } from "../db/supabase.js";
import { createWhatsAppProvider } from "../providers/whatsapp/index.js";
import type { WhatsAppProvider } from "../providers/whatsapp/whatsapp-provider.interface.js";
import { normalizeWebhookMessage, webhookEventType } from "../utils/webhook-message.js";
import { isStatusBroadcast, senderKey } from "../utils/whatsapp-id.js";
import { loadContext,loadConversationMemory } from "../services/context.service.js";
import {
  createEscalation, handleOwnerMessage, conversationPaused,
} from "../services/owner-workflow.service.js";
import { loadOwnerSettings } from "../services/owner-settings.service.js";
import { clientTimeZoneCommand } from "../utils/time-zone.js";
import { isWithinQuietHours, nextQuietHoursEnd } from "../services/escalation.service.js";
import { waitingText } from "../utils/assistant-text.js";
import { clientText } from "../utils/assistant-text.js";
import { withoutRepeatedIntroduction } from '../utils/assistant-text.js';
import { findExactKnowledgeAnswer } from "../services/knowledge.service.js";
import { logSystemEvent, recordAgentAction } from "../services/logging.service.js";
import {
  findOrCreateClient,
  findOrCreateConversation,
  getTenantRouting,
  isTenantServiceable,
} from "../services/tenant.service.js";
import { admitUsage, recordUsageEvent } from "../services/usage.service.js";
import { enabledAgentNames, routeConversation } from '../services/conversation-routing.service.js';
import { inferredLanguage,requestsNoAutomaticReplies } from '../services/client-cards.service.js';

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
    from,
  );
  const conversation = await findOrCreateConversation(db, tenantId, client.id);
  const optedOut=requestsNoAutomaticReplies(text);
  const clientPatch:Record<string,unknown>={};if(!client.language_overridden)clientPatch.language=inferredLanguage(text);if(optedOut){clientPatch.auto_reply_allowed=false;clientPatch.auto_reply_opted_out_at=new Date().toISOString();client.auto_reply_allowed=false;}
  if(Object.keys(clientPatch).length){const preference=await db.from('clients').update(clientPatch).eq('tenant_id',tenantId).eq('id',client.id);if(preference.error)console.error('client_preferences_update_failed',{tenantId,clientId:client.id});}

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
  if(client.auto_reply_allowed===false){if(optedOut)await db.from('conversations').update({bot_paused:true}).eq('tenant_id',tenantId).eq('id',conversation.id);await recordUsageEvent(db,{tenantId,eventType:'message_observed',eventKey:usageKey,metadata:{reason:'client_opt_out',billable:false}});return;}
  const memory=await loadConversationMemory(db,tenantId,conversation.id,behavior(settings).context_message_count,behavior(settings).context_retention_hours);
  const clientReply=(value:string)=>withoutRepeatedIntroduction(value,memory.introduced);
  const markIntroduced=async()=>{if(memory.introduced)return;await db.from('conversations').update({assistant_introduced_at:new Date().toISOString()}).eq('tenant_id',tenantId).eq('id',conversation.id).is('assistant_introduced_at',null);memory.introduced=true;};

  if (settings.auto_replies_paused || await conversationPaused(db, tenantId, conversation.id,settings)) {await recordUsageEvent(db,{tenantId,eventType:'message_observed',eventKey:usageKey,metadata:{reason:'paused',billable:false}});return;}

  const admission=voiceAdmission ? {allowed:true,duplicate:false,unavailable:voiceAdmission.unavailable} : await admitUsage(db,tenantId,usageKey);
  if(admission.duplicate)return;
  if(admission.unavailable)await notifyUsageFailure(db,tenantId,session,provider,settings);
  await deliverUsageNotices(db,tenantId,session,provider);
  if(!admission.allowed){
    await provider.sendMessage({session,chatId:from,text:clientReply(limitClientText(text,settings))});await markIntroduced();
    return;
  }

  const context = await loadContext(db, tenantId);
  const exact = findExactKnowledgeAnswer(text, context.knowledge);
  if(exact.matched){
    return agentContext.run({agent:conversation.routed_agent??'CORE'},async()=>{
      await recordUsageEvent(db,{tenantId,eventType:'message_received',eventKey:usageKey});
      const sent=await provider.sendMessage({session,chatId:from,text:clientReply(clientText(exact.answer))});
      await db.from('messages').insert({conversation_id:conversation.id,tenant_id:tenantId,from_me:true,body:exact.answer,msg_type:'text',waha_msg_id:sent.id||null});await markIntroduced();
      await recordAgentAction(db,{tenantId,conversationId:conversation.id,actionType:'faq_answer_exact',input:text,output:exact.answer});
      await recordUsageEvent(db,{tenantId,eventType:'faq_answer_exact',metadata:{knowledge_item_id:exact.knowledgeItemId}});
    });
  }
  const classification:Record<string,unknown>[]=[];
  const outcome=await routeConversation(db,tenantId,conversation,text,settings,ai===undefined?createAIProvider():ai,usage=>classification.push(usage),memory.messages.length===1);
  for(const metadata of classification)await agentContext.run({agent:'RECEPTION'},()=>recordUsageEvent(db,{tenantId,eventType:'model_call',eventKey:randomUUID(),metadata:{...metadata,purpose:'intent_classification'}}));
  if(outcome.kind==='reception')return agentContext.run({agent:'RECEPTION'},async()=>{
    await recordUsageEvent(db,{tenantId,eventType:'message_received',eventKey:usageKey});
    const clarification=renderText(settings,'client.reception_question',languageOf(text),{agents:enabledAgentNames(settings)});
    const reception=await generateReceptionReply(context,text,clarification,model,memory.messages,memory.introduced);
    if(reception.escalate||!reception.reply){await createEscalation(db,provider,{tenant_id:tenantId,session,conversation_id:conversation.id,client_chat_id:from,client_name:pushName||client.name||clientPhone,question:text,inbound_id:incomingMsgId},settings,client.time_zone);await recordUsageEvent(db,{tenantId,eventType:'escalation_created'});return;}
    const sent=await provider.sendMessage({session,chatId:from,text:clientReply(reception.reply)});
    await db.from('messages').insert({conversation_id:conversation.id,tenant_id:tenantId,from_me:true,body:reception.reply,msg_type:'text',waha_msg_id:sent.id||null});
    const counted=await db.from('conversations').update({reception_message_count:Number(conversation.reception_message_count??0)+1}).eq('tenant_id',tenantId).eq('id',conversation.id);if(counted.error)console.error('reception_counter_update_failed',{tenantId,conversationId:conversation.id});await markIntroduced();
  });
  if(outcome.kind==='escalate')return agentContext.run({agent:'RECEPTION'},async()=>{
    await recordUsageEvent(db,{tenantId,eventType:'message_received',eventKey:usageKey});
    await createEscalation(db,provider,{tenant_id:tenantId,session,conversation_id:conversation.id,client_chat_id:from,client_name:pushName||client.name||clientPhone,question:text,inbound_id:incomingMsgId},settings,client.time_zone);
    await recordUsageEvent(db,{tenantId,eventType:'escalation_created'});
  });
  const agent=outcome.agent;
  return agentContext.run({agent:agent.name},async()=>{
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
    await provider.sendMessage({ session, chatId: from, text: clientReply(confirmation + (quiet ? ' ' + waitingText(text, { at: nextQuietHoursEnd(settings, now), ownerZone: settings.time_zone ?? 'UTC', clientZone },settings) : '')) });await markIntroduced();
    return;
  }

  return agent.execute({answerFromKnowledge:async()=>{
  const clientName = client.name && client.name.trim() !== "" ? client.name : clientPhone;
  const generatedReply = await generateKnowledgeReply(context, text, model,agent.systemPrompt,memory.messages,memory.introduced);
  if (generatedReply) {
    const sent = await provider.sendMessage({
      session, chatId: from, text: clientReply(generatedReply),
    });
    await db.from("messages").insert({
      conversation_id: conversation.id, tenant_id: tenantId, from_me: true,
      body: generatedReply, msg_type: "text", waha_msg_id: sent.id || null,
    });
    await markIntroduced();
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
