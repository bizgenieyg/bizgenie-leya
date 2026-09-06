import { filterIncoming, logRejectedIncoming, ownerIdentityField, readSessionIdentity } from "../utils/incoming-policy.js";
import type { AIProvider } from "../providers/ai/ai-provider.interface.js";
import { generateKnowledgeReply } from "../services/ai-fallback.service.js";
import { supabase, type DatabaseClient } from "../db/supabase.js";
import { createWhatsAppProvider } from "../providers/whatsapp/index.js";
import type { WhatsAppProvider } from "../providers/whatsapp/whatsapp-provider.interface.js";
import { normalizeWebhookMessage, webhookEventType } from "../utils/webhook-message.js";
import { isStatusBroadcast, senderKey, toChatId } from "../utils/whatsapp-id.js";
import { loadContext } from "../services/context.service.js";
import {
  createEscalation,
} from "../services/escalation.service.js";
import { findExactKnowledgeAnswer } from "../services/knowledge.service.js";
import { logSystemEvent, recordAgentAction } from "../services/logging.service.js";
import {
  findOrCreateClient,
  findOrCreateConversation,
  getTenantRouting,
  isTenantServiceable,
} from "../services/tenant.service.js";
import { recordUsageEvent } from "../services/usage.service.js";

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
  const provider: WhatsAppProvider = whatsapp ?? createWhatsAppProvider();

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
      reason: "owner_message", field: ownerField, value: "matched" });
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
  await recordUsageEvent(db, { tenantId, eventType: "message_received" });

  const context = await loadContext(db, tenantId);
  const result = findExactKnowledgeAnswer(text, context.knowledge);
  const clientName = client.name && client.name.trim() !== "" ? client.name : clientPhone;

  if (result.matched) {
    const sent = await provider.sendMessage({
      session,
      chatId: from,
      text: result.answer,
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

  const generatedReply = await generateKnowledgeReply(context, text, ai);
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

  if (!toChatId(tenant.phone)) {
    console.warn("webhook_escalation_skipped", { event, reason: "missing_owner_phone" });
    await logSystemEvent(db, { tenantId, level: "warn", event: "escalation_missing_owner_phone", details: { event } });
    return;
  }
  await createEscalation(db, provider, {
    tenant,
    session,
    conversation,
    clientName,
    clientMessage: text,
  });
  await recordUsageEvent(db, { tenantId, eventType: "escalation_created" });
}
