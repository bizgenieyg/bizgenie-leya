import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { DatabaseClient } from "../db/supabase.js";
import type { WhatsAppProvider } from "../providers/whatsapp/whatsapp-provider.interface.js";
import { submitPlatformFeedback } from "./platform-feedback.service.js";

function fixture(options: { session?: boolean; sendFails?: boolean } = {}) {
  const events: string[] = [];
  const db = {
    from(table: string) {
      if (table === "platform_feedback") return { insert: async (value: unknown) => { events.push(`insert:${JSON.stringify(value)}`); return { error: null }; } };
      const data = table === "tenants"
        ? { business_name: "Studio", name: "Fallback" }
        : options.session === false ? null : { session_name: "tenant-session", status: "WORKING" };
      return { select() { return this; }, eq() { return this; }, async maybeSingle() { return { data, error: null }; } };
    },
  } as unknown as DatabaseClient;
  const provider: WhatsAppProvider = {
    async getSessionStatus() { return { status: "WORKING" }; },
    async sendMessage(input) { events.push(`send:${JSON.stringify(input)}`); if (options.sendFails) throw new Error("offline"); return { id: "sent" }; },
  };
  return { db, provider, events };
}

test("feedback is stored before a tenant-session WhatsApp notification is sent", async () => {
  const { db, provider, events } = fixture();
  assert.deepEqual(await submitPlatformFeedback("tenant-a", "Очень удобно", db, provider, "972500000001@c.us"), { saved: true });
  const inserted = events[0], notification = events[1];
  assert.ok(inserted);assert.ok(notification);
  assert.match(inserted, /^insert:/);
  assert.deepEqual(JSON.parse(inserted.slice("insert:".length)), { tenant_id: "tenant-a", message: "Очень удобно" });
  const sent = JSON.parse(notification.slice("send:".length));
  assert.deepEqual(sent, { session: "tenant-session", chatId: "972500000001@c.us", text: "Отзыв от тенанта Studio (tenant-a): Очень удобно" });
});

for (const options of [{ session: false }, { sendFails: true }]) {
  test("notification failure does not turn saved feedback into a request failure", async () => {
    const { db, provider, events } = fixture(options);
    const originalError = console.error;
    const logs: unknown[][] = [];
    console.error = (...args: unknown[]) => { logs.push(args); };
    try {
      assert.deepEqual(await submitPlatformFeedback("tenant-a", "Saved", db, provider, "972500000001@c.us"), { saved: true });
      const inserted = events[0];assert.ok(inserted);assert.match(inserted, /^insert:/);
      assert.equal(logs[0]?.[0], "platform_feedback_notification_failed");
      assert.doesNotMatch(JSON.stringify(logs), /Saved/);
    } finally { console.error = originalError; }
  });
}

test("platform_feedback migration grants insert only and keeps reads service-role-only", () => {
  const sql = readFileSync("supabase/migrations/20260922181956_platform_feedback.sql", "utf8");
  assert.match(sql, /alter table public\.platform_feedback enable row level security/i);
  assert.match(sql, /revoke all on table public\.platform_feedback from anon, authenticated/i);
  assert.match(sql, /grant insert on table public\.platform_feedback to authenticated/i);
  assert.match(sql, /grant select, insert, update, delete on table public\.platform_feedback to service_role/i);
  assert.match(sql, /tenant_users\.user_id = \(select auth\.uid\(\)\)/i);
  assert.doesNotMatch(sql, /for select\s+to authenticated/i);
});
