import type { SupabaseClient } from "@supabase/supabase-js";

type Json = Record<string, unknown>;

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Append a row to `system_logs`. Never pass secrets in `details` — callers are
 * responsible for keeping API keys, webhook secrets and tokens out of the payload.
 */
export async function logSystemEvent(
  db: SupabaseClient,
  input: { tenantId: string | null; level: LogLevel; event: string; details?: Json },
): Promise<void> {
  const { error } = await db.from("system_logs").insert({
    tenant_id: input.tenantId,
    level: input.level,
    event: input.event,
    details: input.details ?? {},
  });
  if (error) {
    console.error(`system_logs insert failed for event "${input.event}"`);
  }
}

/** Append a structured row to `agent_actions` (the per-conversation audit trail). */
export async function recordAgentAction(
  db: SupabaseClient,
  input: {
    tenantId: string;
    conversationId: string | null;
    actionType: string;
    input?: string | null;
    output?: string | null;
  },
): Promise<void> {
  const { error } = await db.from("agent_actions").insert({
    tenant_id: input.tenantId,
    conversation_id: input.conversationId,
    action_type: input.actionType,
    input: input.input ?? null,
    output: input.output ?? null,
  });
  if (error) {
    console.error(`agent_actions insert failed for action "${input.actionType}"`);
  }
}
