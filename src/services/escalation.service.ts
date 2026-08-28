import type { SupabaseClient } from "@supabase/supabase-js";

import { requireEnv } from "../config/env.js";
import { createWhatsAppProvider } from "../providers/whatsapp/index.js";
import type { WhatsAppProvider } from "../providers/whatsapp/whatsapp-provider.interface.js";
import { decryptCredential } from "../utils/crypto.js";
import { toChatId } from "../utils/whatsapp-id.js";
import { logSystemEvent, recordAgentAction } from "./logging.service.js";
import type { ConversationRow, TenantRow } from "./tenant.service.js";

const ESCALATION_JOB = "escalation_delivery";

interface NotificationSettings {
  mode: string;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
}

/** Owner-facing escalation text (system notification, not a client message). */
export function buildEscalationText(clientName: string, clientMessage: string): string {
  return [
    `❓ Новый вопрос от ${clientName}:`,
    "",
    clientMessage,
    "",
    "Лея не нашла ответ в базе знаний.",
  ].join("\n");
}

function toMinutes(hhmmss: string): number | null {
  const match = /^(\d{2}):(\d{2})/.exec(hhmmss);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Phase 1 quiet-hours check. Only `mode === 'mute_all'` is honoured.
 * Handles windows that wrap past midnight (start > end).
 */
export function isWithinQuietHours(
  settings: NotificationSettings,
  now: Date,
): boolean {
  if (settings.mode !== "mute_all") {
    return false;
  }
  if (!settings.quiet_hours_start || !settings.quiet_hours_end) {
    return false;
  }
  const start = toMinutes(settings.quiet_hours_start);
  const end = toMinutes(settings.quiet_hours_end);
  if (start === null || end === null || start === end) {
    return false;
  }
  const current = now.getHours() * 60 + now.getMinutes();
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

/** Next wall-clock occurrence of `quiet_hours_end` at or after `now`. */
export function nextQuietHoursEnd(
  settings: NotificationSettings,
  now: Date,
): Date {
  const end = settings.quiet_hours_end ? toMinutes(settings.quiet_hours_end) : null;
  const target = new Date(now);
  if (end === null) {
    return target;
  }
  target.setHours(Math.floor(end / 60), end % 60, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target;
}

async function loadNotificationSettings(
  db: SupabaseClient,
  tenantId: string,
): Promise<NotificationSettings | null> {
  const { data, error } = await db
    .from("notification_settings")
    .select("mode, quiet_hours_start, quiet_hours_end")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error || !data) {
    return null;
  }
  return {
    mode: (data.mode as string | null) ?? "mute_all",
    quiet_hours_start: (data.quiet_hours_start as string | null) ?? null,
    quiet_hours_end: (data.quiet_hours_end as string | null) ?? null,
  };
}

export interface CreateEscalationInput {
  tenant: TenantRow;
  session: string;
  conversation: ConversationRow;
  clientName: string;
  clientMessage: string;
}

export interface CreateEscalationResult {
  queued: boolean;
  wahaMsgId?: string;
}

/**
 * Notify the owner that the Knowledge Module had no answer.
 *
 * Inside quiet hours the send is deferred into `scheduled_jobs`; otherwise it
 * goes out immediately and its WAHA message id is stored on the
 * `escalation_created` agent action for later reply matching.
 */
export async function createEscalation(
  db: SupabaseClient,
  provider: WhatsAppProvider,
  input: CreateEscalationInput,
): Promise<CreateEscalationResult> {
  const { tenant, session, conversation, clientName, clientMessage } = input;
  const text = buildEscalationText(clientName, clientMessage);
  const ownerChatId = toChatId(tenant.phone);

  const settings = await loadNotificationSettings(db, tenant.id);
  const now = new Date();

  if (settings && isWithinQuietHours(settings, now)) {
    const scheduledAt = nextQuietHoursEnd(settings, now);
    const { error } = await db.from("scheduled_jobs").insert({
      tenant_id: tenant.id,
      job_type: ESCALATION_JOB,
      payload: {
        conversation_id: conversation.id,
        session,
        owner_chat_id: ownerChatId,
        text,
        client_message: clientMessage,
      },
      scheduled_at: scheduledAt.toISOString(),
      status: "pending",
    });
    if (error) {
      throw new Error("Could not queue escalation delivery");
    }
    await recordAgentAction(db, {
      tenantId: tenant.id,
      conversationId: conversation.id,
      actionType: "escalation_created",
      input: clientMessage,
      output: null,
    });
    await logSystemEvent(db, {
      tenantId: tenant.id,
      level: "info",
      event: "escalation_queued",
      details: {
        conversation_id: conversation.id,
        scheduled_at: scheduledAt.toISOString(),
      },
    });
    return { queued: true };
  }

  const sent = await provider.sendMessage({ session, chatId: ownerChatId, text });
  await recordAgentAction(db, {
    tenantId: tenant.id,
    conversationId: conversation.id,
    actionType: "escalation_created",
    input: clientMessage,
    output: sent.id || null,
  });
  await logSystemEvent(db, {
    tenantId: tenant.id,
    level: "info",
    event: "escalation_created",
    details: { conversation_id: conversation.id, waha_msg_id: sent.id || null },
  });
  return sent.id ? { queued: false, wahaMsgId: sent.id } : { queued: false };
}

export interface EscalationMatch {
  conversationId: string;
  clientId: string;
  clientPhone: string;
  session: string;
}

/**
 * Reply matching (chef-bot lesson): an owner message counts as an escalation
 * answer only when it quotes the exact escalation message we sent.
 */
export async function findEscalationByReplyId(
  db: SupabaseClient,
  tenantId: string,
  replyToId: string,
  fallbackSession: string,
): Promise<EscalationMatch | null> {
  const { data: actions, error } = await db
    .from("agent_actions")
    .select("id, conversation_id, output")
    .eq("tenant_id", tenantId)
    .eq("action_type", "escalation_created")
    .eq("output", replyToId)
    .order("created_at", { ascending: false })
    .limit(1);
  const action = actions?.[0];
  if (error || !action) {
    return null;
  }
  const conversationId = action.conversation_id as string | null;
  if (!conversationId) {
    return null;
  }

  const { data: conversation } = await db
    .from("conversations")
    .select("id, client_id")
    .eq("id", conversationId)
    .maybeSingle();
  if (!conversation) {
    return null;
  }

  const { data: client } = await db
    .from("clients")
    .select("id, phone")
    .eq("id", conversation.client_id)
    .maybeSingle();
  if (!client) {
    return null;
  }

  return {
    conversationId: conversation.id as string,
    clientId: client.id as string,
    clientPhone: client.phone as string,
    session: fallbackSession,
  };
}

interface ScheduledJobRow {
  id: string;
  tenant_id: string;
  payload: {
    conversation_id?: string;
    session?: string;
    owner_chat_id?: string;
    text?: string;
    client_message?: string;
  };
}

async function providerForTenant(
  db: SupabaseClient,
  tenantId: string,
): Promise<WhatsAppProvider> {
  const { data } = await db
    .from("whatsapp_instances")
    .select("waha_api_key_encrypted")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const encrypted = (data?.waha_api_key_encrypted as string | null) ?? null;
  if (!encrypted) {
    return createWhatsAppProvider();
  }
  try {
    return createWhatsAppProvider(
      decryptCredential(encrypted, requireEnv("CREDENTIAL_ENCRYPTION_KEY")),
    );
  } catch {
    return createWhatsAppProvider();
  }
}

/**
 * Deliver escalations that were deferred by quiet hours and are now due.
 * Intended to be invoked by a scheduler (PM2 cron / external cron), not the web process.
 */
export async function runDueScheduledEscalations(
  db: SupabaseClient,
  nowIso: string = new Date().toISOString(),
): Promise<number> {
  const { data: jobs, error } = await db
    .from("scheduled_jobs")
    .select("id, tenant_id, payload")
    .eq("job_type", ESCALATION_JOB)
    .eq("status", "pending")
    .lte("scheduled_at", nowIso)
    .limit(50);
  if (error || !jobs || jobs.length === 0) {
    return 0;
  }

  let delivered = 0;
  for (const job of jobs as ScheduledJobRow[]) {
    const payload = job.payload ?? {};
    if (!payload.owner_chat_id || !payload.text || !payload.session) {
      await db
        .from("scheduled_jobs")
        .update({ status: "error", error: "malformed escalation payload" })
        .eq("id", job.id);
      continue;
    }
    try {
      const provider = await providerForTenant(db, job.tenant_id);
      const sent = await provider.sendMessage({
        session: payload.session,
        chatId: payload.owner_chat_id,
        text: payload.text,
      });
      await db
        .from("scheduled_jobs")
        .update({ status: "done", executed_at: new Date().toISOString() })
        .eq("id", job.id);
      await recordAgentAction(db, {
        tenantId: job.tenant_id,
        conversationId: payload.conversation_id ?? null,
        actionType: "escalation_created",
        input: payload.client_message ?? null,
        output: sent.id || null,
      });
      await logSystemEvent(db, {
        tenantId: job.tenant_id,
        level: "info",
        event: "escalation_delivered",
        details: {
          conversation_id: payload.conversation_id ?? null,
          waha_msg_id: sent.id || null,
        },
      });
      delivered += 1;
    } catch (jobError) {
      await db
        .from("scheduled_jobs")
        .update({
          status: "error",
          error: jobError instanceof Error ? jobError.message : "unknown error",
        })
        .eq("id", job.id);
    }
  }
  return delivered;
}
