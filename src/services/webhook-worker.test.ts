import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import type { DatabaseClient } from "../db/supabase.js";
import type { WhatsAppProvider } from "../providers/whatsapp/whatsapp-provider.interface.js";
process.env.GEMINI_API_KEY = "";
process.env.SUPABASE_URL = "https://database.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";

test("GOWS incoming FAQ gets a deterministic reply even when tenants.phone is null", async () => {
  const { handleWebhookEvent } = await import("../workers/webhook.worker.js");
  const writes: { table: string; data: Record<string, unknown> }[] = [];
  const sent: string[] = [];
  const recipients: string[] = [];
  const clientKeys: unknown[] = [];
  let quotaAllowed = true;
  const db = { async rpc() { return {data:{allowed:quotaAllowed,duplicate:false},error:null}; }, from(table: string) {
    let write = false;
    const query = {
      select() { return query; }, eq(column: string, value: unknown) { if (table === "clients" && column === "phone") clientKeys.push(value); return query; }, in(){return query;},is(){return query;},gte(){return query;},lt(){return query;},not() { return query; }, order() { return query; }, limit() { return query; },delete(){write=true;return query;},
      update() { write = true; return query; },
      insert(data: Record<string, unknown>) { write = true; writes.push({ table, data }); return query; },
      async maybeSingle() {
        const rows: Record<string, unknown> = {
          tenants: { id: "123e4567-e89b-42d3-a456-426614174000", phone: null, status: "active" },
          whatsapp_instances: { session_name: "tenant-test" },
          clients: { id: "client", name: "Тест", phone: "972500000001" },
          assistant_profiles: {},
        };
        return { data: rows[table] ?? null, error: null };
      },
      then(resolve: (value: unknown) => unknown) {
        const data = write ? null : table === "knowledge_items"
          ? [{ id: "faq", question: "Часы работы?", answer: "С 9 до 18." }]
          : table === "conversations" ? [{ id: "conversation", client_id: "client", last_message_at:new Date().toISOString() }] : [];
        return Promise.resolve(resolve({ data, error: null }));
      },
    };
    return query;
  } } as unknown as DatabaseClient;
  const provider: WhatsAppProvider = {
    async sendMessage(input) { sent.push(input.text); recipients.push(input.chatId); return { id: "reply" }; },
    async getSessionStatus() { return { status: "WORKING" }; },
  };
  const body = { event: "message", payload: {
    from: "972500000001@c.us", fromMe: false, hasMedia: false, body: "Часы работы?", author: null, replyTo: null,
    _data: { Info: { PushName: "Тест" } },
  } };
  let aiCalls = 0;
  const ai = { async generateReply(input:{systemPrompt:string}) { aiCalls++; return { text: input.systemPrompt.includes('классификатор намерений') ? '{"agent":"SUPPORT","confidence":0.9}' : "Открыты с 9 до 18." }; } };
  await handleWebhookEvent("123e4567-e89b-42d3-a456-426614174000", body, db, provider, ai);
  assert.equal(aiCalls, 0);
  assert.deepEqual(sent, ["С 9 до 18."]);
  assert.ok(writes.some(write => write.table === "agent_actions" && write.data.action_type === "faq_answer_exact"));
  const warn = console.warn;
  const info = console.info;
  const warnings: unknown[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  console.info = (...args: unknown[]) => { warnings.push(args); };
  try {
    await handleWebhookEvent("123e4567-e89b-42d3-a456-426614174000",
      { ...body, payload: { ...body.payload, body: null } }, db, provider);
    await handleWebhookEvent("123e4567-e89b-42d3-a456-426614174000",
      { ...body, payload: { ...body.payload, body: "Нет в FAQ" } }, db, provider);
    assert.equal(sent.length, 1);
    assert.match(JSON.stringify(warnings), /missing_text/);
    assert.match(JSON.stringify(warnings), /missing_owner_phone/);
    assert.doesNotMatch(JSON.stringify(warnings), /Нет в FAQ|972500000001/);
    await handleWebhookEvent("123e4567-e89b-42d3-a456-426614174000",
      { ...body, payload: { ...body.payload, body: "Когда вы открыты?" } }, db, provider, ai);
    assert.equal(aiCalls, 2);
    assert.equal(sent[1], "Открыты с 9 до 18.");
    await handleWebhookEvent("123e4567-e89b-42d3-a456-426614174000",
      { ...body, payload: { ...body.payload, body: "Другой вопрос" } }, db, provider,
      { async generateReply() { throw new Error("private error"); } });
    assert.equal(sent.length, 2);
    const lid = "261885798707406@lid";
    await handleWebhookEvent("123e4567-e89b-42d3-a456-426614174000",
      { ...body, payload: { ...body.payload, from: lid } }, db, provider, ai);
    await handleWebhookEvent("123e4567-e89b-42d3-a456-426614174000",
      { ...body, payload: { ...body.payload, from: lid, body: "Переформулированный вопрос" } }, db, provider, ai);
    assert.deepEqual(recipients.slice(-2), [lid, lid]);
    assert.deepEqual(clientKeys.slice(-2), [lid, lid]);
    assert.ok(aiCalls >= 2);
    const realPayload = JSON.parse(readFileSync("src/services/fixtures/gows-incoming-lid.json", "utf8"));
    await handleWebhookEvent("123e4567-e89b-42d3-a456-426614174000", realPayload, db, provider, ai);
    assert.equal(recipients.at(-1), realPayload.payload.from);
    assert.equal(sent.at(-1), "С 9 до 18.");
    assert.equal(clientKeys.at(-1), realPayload.payload.from);
    for (const field of ["id", "lid"]) {
      const count: number = sent.length;
      const queries: number = clientKeys.length;
      const ownerPayload = structuredClone(realPayload);
      ownerPayload.payload.from = ownerPayload.me[field];
      ownerPayload.payload._data.Info.Chat = ownerPayload.me[field];
      await handleWebhookEvent("123e4567-e89b-42d3-a456-426614174000", ownerPayload, db, provider, ai);
      assert.equal(sent.length, count);
      assert.equal(clientKeys.length, queries);
    }
    quotaAllowed = false;
    const callsBefore = aiCalls;
    for (const question of ["Часы работы?", "Неизвестный вопрос"]) {
      await handleWebhookEvent("123e4567-e89b-42d3-a456-426614174000",
        {...body,payload:{...body.payload,body:question}},db,provider,ai);
      assert.match(sent.at(-1)!, /автоматические ответы недоступны/);
    }
    assert.equal(aiCalls,callsBefore);
    assert.match(JSON.stringify(warnings), /owner_message/);
    assert.match(JSON.stringify(warnings), /session.me.lid/);
  } finally { console.warn = warn; console.info = info; }
});
