import assert from "node:assert/strict";
import test from "node:test";
import type { DatabaseClient } from "../db/supabase.js";
process.env.SUPABASE_URL = "https://database.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";
process.env.WHATSAPP_ALLOWLIST_ENABLED = "true";
process.env.WHATSAPP_ALLOWLIST_NUMBERS = "972500000001";

test("rejected messages never reach DB, FAQ, Gemini or WhatsApp", async () => {
  const { handleWebhookEvent } = await import("../workers/webhook.worker.js");
  let calls = 0;
  const db = { from() { calls++; throw new Error("must not reach business handler"); } } as unknown as DatabaseClient;
  const provider = { async sendMessage() { calls++; return { id: "" }; }, async getSessionStatus() { return { status: "WORKING" }; } };
  const ai = { async generateReply() { calls++; return { text: "bad" }; } };
  const logs: unknown[][] = [];
  const info = console.info;
  console.info = (...args: unknown[]) => { logs.push(args); };
  try {
    for (const patch of [{ from: "123456789@g.us" }, { fromMe: true }, { from: "972500000003@c.us" }, { hasMedia: true }]) {
      await handleWebhookEvent("tenant", { event: "message", payload: { from: "972500000001@c.us", fromMe: false, hasMedia: false, body: "private АУДИТ", ...patch } }, db, provider, ai);
    }
    assert.equal(calls, 0);
    assert.equal(logs.length, 4);
    assert.ok(logs.every(args => args.length === 1 && !String(args[0]).includes("\n")));
    assert.doesNotMatch(JSON.stringify(logs), /АУДИТ|972500000003/);
  } finally { console.info = info; }
});

test("allowlist also blocks owner escalations before provider or database calls", async () => {
  const { createEscalation } = await import("./escalation.service.js");
  const db = { from() { throw new Error("must not access database"); } } as unknown as DatabaseClient;
  let sends = 0;
  const provider = { async sendMessage() { sends++; return { id: "" }; }, async getSessionStatus() { return { status: "WORKING" }; } };
  const info = console.info; console.info = () => {};
  try {
    await createEscalation(db, provider, {
      tenant: { id: "tenant", name: "test", phone: "+972500000003", status: "active", language: "ru" },
      session: "session", conversation: { id: "conversation", tenant_id: "tenant", client_id: "client", status: "active" },
      clientName: "test", clientMessage: "private",
    });
    assert.equal(sends, 0);
  } finally { console.info = info; }
});
