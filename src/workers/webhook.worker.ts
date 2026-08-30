import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "../db/supabase.js";
import { createWhatsAppProvider } from "../providers/whatsapp/index.js";
import type { WhatsAppProvider } from "../providers/whatsapp/whatsapp-provider.interface.js";
import { extractMessageId } from "../providers/whatsapp/waha.provider.js";
import { digitsOf, isStatusBroadcast, stripJidSuffix, toChatId } from "../utils/whatsapp-id.js";
import { loadContext } from "../services/context.service.js";
import {
  createEscalation,
  findEscalationByReplyId,
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

const MESSAGE_EVENTS = new Set(["message", "message.any"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

/** `payload._data.Info.PushName` — the GOWS client display name. */
function readPushName(message: Record<string, unknown>): string | null {
  const data = asRecord(message._data);
  const info = data ? asRecord(data.Info) : null;
  const pushName = info ? info.PushName : undefined;
  return typeof pushName === "string" && pushName.trim() !== "" ? pushName : null;
}

/** `payload.replyTo.id` — the quoted message id, used for escalation reply matching. */
function readReplyToId(message: Record<string, unknown>): string | null {
  const replyTo = asRecord(message.replyTo);
  if (!replyTo) {
    return null;
  }
  const id = replyTo.id;
  return typeof id === "string" && id !== "" ? id : null;
}

/**
 * Process one already-authenticated webhook body for `tenantId`.
 *
 * Resolves tenant/client/conversation, persists the inbound message with its raw
 * payload, then either answers with an exact FAQ match or escalates to the owner.
 * Owner replies that quote an escalation are relayed back to the client.
 */
export async function handleWebhookEvent(
  tenantId: string,
  body: Record<string, unknown>,
  db: SupabaseClient = supabase,
): Promise<void> {
  const event = readString(body, "event");
  const message = asRecord(body.payload) ?? body;

  if (event !== "" && !MESSAGE_EVENTS.has(event)) {
    await logSystemEvent(db, {
      tenantId,
      level: "info",
      event: "webhook_ignored_event",
      details: { event },
    });
    return;
  }

  const from = readString(message, "from");
  if (from === "" || isStatusBroadcast(from)) {
    await logSystemEvent(db, {
      tenantId,
      level: "info",
      event: "webhook_ignored_non_message",
      details: {},
    });
    return;
  }

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
    (instance?.session_name && instance.session_name.trim()) ||
    readString(body, "session") ||
    "default";
  const provider: WhatsAppProvider = createWhatsAppProvider();

  const text = readString(message, "body");
  const incomingMsgId = extractMessageId(message.id) || null;
  const replyToId = readReplyToId(message);
  const fromMe = message.fromMe === true;
  const ownerDigits = digitsOf(tenant.phone);
  const senderDigits = digitsOf(from);
  const isOwner =
    fromMe || (ownerDigits !== "" && ownerDigits === senderDigits);

  // Owner messages are never treated as client questions. The one meaningful
  // case is an owner reply quoting an escalation we sent.
  if (isOwner) {
    if (replyToId && text.trim() !== "") {
      await relayOwnerReply(db, provider, tenantId, session, replyToId, text);
    }
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

  const clientPhone = stripJidSuffix(from);
  const client = await findOrCreateClient(
    db,
    tenantId,
    clientPhone,
    readPushName(message),
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

  if (text.trim() === "") {
    await logSystemEvent(db, {
      tenantId,
      level: "info",
      event: "message_without_text",
      details: { conversation_id: conversation.id },
    });
    return;
  }

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

  await createEscalation(db, provider, {
    tenant,
    session,
    conversation,
    clientName,
    clientMessage: text,
  });
  await recordUsageEvent(db, { tenantId, eventType: "escalation_created" });
}

async function relayOwnerReply(
  db: SupabaseClient,
  provider: WhatsAppProvider,
  tenantId: string,
  session: string,
  replyToId: string,
  ownerText: string,
): Promise<void> {
  const match = await findEscalationByReplyId(db, tenantId, replyToId, session);
  if (!match) {
    await logSystemEvent(db, {
      tenantId,
      level: "info",
      event: "owner_reply_unmatched",
      details: {},
    });
    return;
  }

  const sent = await provider.sendMessage({
    session,
    chatId: toChatId(match.clientPhone),
    text: ownerText,
  });
  await db.from("messages").insert({
    conversation_id: match.conversationId,
    tenant_id: tenantId,
    from_me: true,
    body: ownerText,
    msg_type: "text",
    waha_msg_id: sent.id || null,
  });
  await recordAgentAction(db, {
    tenantId,
    conversationId: match.conversationId,
    actionType: "escalation_reply_relayed",
    input: replyToId,
    output: ownerText,
  });
  await logSystemEvent(db, {
    tenantId,
    level: "info",
    event: "escalation_reply_relayed",
    details: { conversation_id: match.conversationId },
  });
}
