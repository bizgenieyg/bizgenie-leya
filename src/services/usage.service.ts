import type { SupabaseClient } from "@supabase/supabase-js";

/** Append a billing/usage signal to `usage_events`. Kept intentionally minimal for Phase 1. */
export async function recordUsageEvent(
  db: SupabaseClient,
  input: {
    tenantId: string;
    eventType: string;
    quantity?: number;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await db.from("usage_events").insert({
    tenant_id: input.tenantId,
    event_type: input.eventType,
    quantity: input.quantity ?? 1,
    metadata: input.metadata ?? {},
  });
  if (error) {
    console.error(`usage_events insert failed for event "${input.eventType}"`);
  }
}
