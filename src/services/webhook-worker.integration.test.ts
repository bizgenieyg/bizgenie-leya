import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import type { WhatsAppProvider } from "../providers/whatsapp/whatsapp-provider.interface.js";
import { createTestDatabase, pgliteDatabaseClient } from "./test-support/pglite-harness.js";
process.env.GEMINI_API_KEY = "";
process.env.SUPABASE_URL = "https://database.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";

// Converted to PGlite (real migrations) per review. The previous hand-rolled mock
// answered every `.maybeSingle()` with a fixed canned row per table name regardless of
// the actual filters applied, and every list query with a hardcoded FAQ/conversation
// row — so it could never notice a query that filtered on the wrong column, a type
// mismatch, or a constraint violation. It also could not tell us whether
// `tenants.phone` being null is actually schema-legal (it is: migration 004 drops
// the NOT NULL — the assistant confirmed this empirically while converting the test,
// see report) versus an artifact of the mock. Running the real webhook pipeline
// end-to-end against real tables is what would have caught the simulator's non-UUID
// conversation id (see simulator.service.ts git history) had this file covered it.
test("GOWS incoming FAQ gets a deterministic reply even when tenants.phone is null", async () => {
  const { handleWebhookEvent } = await import("../workers/webhook.worker.js");
  const pg = await createTestDatabase();
  try {
    const db = pgliteDatabaseClient(pg);
    const tenantRow = (await db.from("tenants").insert({ name: "Business", business_name: "Business", phone: null, language: "ru", tier: "basic", status: "active" }).select("id").single()).data as { id: string };
    const tenantId = tenantRow.id;
    await pg.query("insert into notification_settings(tenant_id,mode,time_zone,auto_replies_paused) values($1,'mute_all','Asia/Jerusalem',false)", [tenantId]);
    await pg.query("insert into plans(code,display_name,messages_per_month,voice_minutes_per_month,warning_percent,unlimited) values('basic','Базовый',500,60,80,false) on conflict(code) do nothing");
    await pg.query("insert into tenant_usage_limits(tenant_id,plan,messages_per_month,voice_minutes_per_month,warning_percent,messages_overridden,voice_overridden,warning_overridden) values($1,'basic',500,60,80,false,false,false)", [tenantId]);
    await pg.query("insert into assistant_profiles(tenant_id,assistant_name,allowed_languages,tone) values($1,'Leya',array['ru'],'friendly_professional')", [tenantId]);
    await pg.query("insert into knowledge_items(tenant_id,type,question,answer,active) values($1,'faq','Часы работы?','С 9 до 18.',true)", [tenantId]);

    const sent: string[] = [];
    const recipients: string[] = [];
    const provider: WhatsAppProvider = {
      async sendMessage(input) { sent.push(input.text); recipients.push(input.chatId); return { id: `reply-${sent.length}` }; },
      async getSessionStatus() { return { status: "WORKING" }; },
    };
    const body = {
      event: "message", payload: {
        from: "972500000001@c.us", fromMe: false, hasMedia: false, body: "Часы работы?", author: null, replyTo: null,
        _data: { Info: { PushName: "Тест" } },
      },
    };
    let aiCalls = 0;
    const ai = { async generateReply(input: { systemPrompt: string }) { aiCalls++; return { text: input.systemPrompt.includes('классификатор намерений') ? '{"agent":"SUPPORT","confidence":0.9}' : "Открыты с 9 до 18." }; } };

    await handleWebhookEvent(tenantId, body, db, provider, ai as never);
    assert.equal(aiCalls, 0);
    assert.deepEqual(sent, ["С 9 до 18."]);
    const actions = (await pg.query<{ action_type: string }>("select action_type from agent_actions where tenant_id=$1", [tenantId])).rows;
    assert.ok(actions.some(a => a.action_type === "faq_answer_exact"));

    const warn = console.warn, info = console.info;
    const warnings: unknown[] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    console.info = (...args: unknown[]) => { warnings.push(args); };
    try {
      await handleWebhookEvent(tenantId, { ...body, payload: { ...body.payload, body: null } }, db, provider, undefined);
      await handleWebhookEvent(tenantId, { ...body, payload: { ...body.payload, body: "Нет в FAQ" } }, db, provider, undefined);
      assert.equal(sent.length, 1);
      assert.match(JSON.stringify(warnings), /missing_text/);
      assert.match(JSON.stringify(warnings), /missing_owner_phone/);
      assert.doesNotMatch(JSON.stringify(warnings), /Нет в FAQ|972500000001/);

      await handleWebhookEvent(tenantId, { ...body, payload: { ...body.payload, body: "Когда вы открыты?" } }, db, provider, ai as never);
      assert.equal(aiCalls, 2);
      assert.equal(sent[1], "Открыты с 9 до 18.");

      await handleWebhookEvent(tenantId, { ...body, payload: { ...body.payload, body: "Другой вопрос" } }, db, provider, { async generateReply() { throw new Error("private error"); } } as never);
      assert.equal(sent.length, 2);

      const lid = "261885798707406@lid";
      await handleWebhookEvent(tenantId, { ...body, payload: { ...body.payload, from: lid } }, db, provider, ai as never);
      await handleWebhookEvent(tenantId, { ...body, payload: { ...body.payload, from: lid, body: "Переформулированный вопрос" } }, db, provider, ai as never);
      assert.deepEqual(recipients.slice(-2), [lid, lid]);
      const lidClient = await pg.query<{ count: string }>("select count(*)::text as count from clients where tenant_id=$1 and whatsapp_jid=$2", [tenantId, lid]);
      assert.equal(lidClient.rows[0]!.count, "1", "the @lid contact resolves to exactly one client row across both messages");
      // A different WhatsApp JID with the same digits and display name is never merged
      // into the @lid client, even though it looks like the same contact: two real
      // contacts can share a name (see migration 048), so only an exact JID match counts.
      await handleWebhookEvent(tenantId, { ...body, payload: { ...body.payload, from: "261885798707406@c.us", body: "Тот же контакт" } }, db, provider, ai as never);
      const aliasedClients = await pg.query<{ count: string }>("select count(*)::text as count from clients where tenant_id=$1 and regexp_replace(whatsapp_jid,'@.*$','')='261885798707406'", [tenantId]);
      assert.equal(aliasedClients.rows[0]!.count, "2", "matching digits under a different JID suffix create a separate client card, not a merge");
      assert.ok(aiCalls >= 2);

      const realPayload = JSON.parse(readFileSync("src/services/fixtures/gows-incoming-lid.json", "utf8"));
      await handleWebhookEvent(tenantId, realPayload, db, provider, ai as never);
      assert.equal(recipients.at(-1), realPayload.payload.from);
      assert.equal(sent.at(-1), "С 9 до 18.");
      const realClient = await pg.query<{ count: string }>("select count(*)::text as count from clients where tenant_id=$1 and whatsapp_jid=$2", [tenantId, realPayload.payload.from]);
      assert.equal(realClient.rows[0]!.count, "1");

      const multilingualAi={async generateReply(input:{systemPrompt:string}){
        if(input.systemPrompt.includes('классификатор намерений'))return{text:'{"agent":"SUPPORT","confidence":0.95}'};
        if(input.systemPrompt.includes('Язык этого ответа: he'))return{text:'תשובה בעברית.'};
        if(input.systemPrompt.includes('Язык этого ответа: ru'))return{text:'Ответ по-русски.'};
        return{text:'Answer in English.'};
      }};
      const languageClient='972500000006@c.us';
      for(const [question,expected] of [['שלום, אפשר עזרה?','תשובה בעברית.'],['Нужна помощь','Ответ по-русски.'],['Can you help?','Answer in English.'],['שוב בעברית','תשובה בעברית.']] as const){
        await handleWebhookEvent(tenantId,{...body,payload:{...body.payload,from:languageClient,body:question}},db,provider,multilingualAi as never);
        assert.equal(sent.at(-1),expected);
      }
      const observed=await pg.query<{language:string}>("select language from clients where tenant_id=$1 and whatsapp_jid=$2",[tenantId,languageClient]);
      assert.equal(observed.rows[0]!.language,'he','the card observes the latest incoming language');
      await pg.query("update clients set language='ru',language_overridden=true where tenant_id=$1 and whatsapp_jid=$2",[tenantId,languageClient]);
      await handleWebhookEvent(tenantId,{...body,payload:{...body.payload,from:languageClient,body:'עוד שאלה'}},db,provider,multilingualAi as never);
      assert.equal(sent.at(-1),'Ответ по-русски.','an explicit owner override remains authoritative');

      const groupJid='120363400030260280@c.us';
      const sentBeforeGroup=sent.length;
      await handleWebhookEvent(tenantId,{...body,payload:{...body.payload,from:groupJid,participant:'972500000007@lid',_data:{Info:{Chat:groupJid,IsGroup:true,IsFromMe:false}},body:'Сообщение группы'}},db,provider,ai as never);
      assert.equal(sent.length,sentBeforeGroup);
      const groupClients=await pg.query<{count:string}>("select count(*)::text as count from clients where tenant_id=$1 and whatsapp_jid=$2",[tenantId,groupJid]);
      assert.equal(groupClients.rows[0]!.count,'0','a GOWS group event cannot create a client card');

      for (const field of ["id", "lid"]) {
        const sentBefore: number = sent.length;
        const ownerPayload = structuredClone(realPayload);
        ownerPayload.payload.from = ownerPayload.me[field];
        ownerPayload.payload._data.Info.Chat = ownerPayload.me[field];
        await handleWebhookEvent(tenantId, ownerPayload, db, provider, ai as never);
        assert.equal(sent.length, sentBefore, `an inbound event matching session.me.${field} must be filtered as the bot's own identity, not a client`);
      }

      await pg.query("update tenant_usage_limits set messages_per_month=0,messages_overridden=true where tenant_id=$1", [tenantId]);
      const callsBefore = aiCalls;
      for (const question of ["Часы работы?", "Неизвестный вопрос"]) {
        await handleWebhookEvent(tenantId, { ...body, payload: { ...body.payload, body: question } }, db, provider, ai as never);
        assert.match(sent.at(-1)!, /автоматические ответы недоступны/);
      }
      assert.equal(aiCalls, callsBefore);
      assert.match(JSON.stringify(warnings), /owner_message/);
      assert.match(JSON.stringify(warnings), /session.me.lid/);
    } finally { console.warn = warn; console.info = info; }
  } finally { await pg.close(); }
});
