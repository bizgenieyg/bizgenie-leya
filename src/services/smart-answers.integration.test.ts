import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { createTestDatabase, pgliteDatabaseClient } from './test-support/pglite-harness.js';
import { settleAllOutboundQueues, stopOutboundQueue } from '../workers/outbound-queue.js';
import { handleOwnerMessage } from './owner-workflow.service.js';
import { loadOwnerSettings, invalidateOwnerSettings } from './owner-settings.service.js';
import { deliverOwnerSummaryIfDue } from './owner-summary.service.js';
import { proposeKnowledgeSuggestion } from './knowledge-suggestions.service.js';
import { loadKnowledgeMaterials } from './knowledge-context.service.js';
import { loadContext } from './context.service.js';
import { clearClientPhoneCache, resolveClientPhone, resolveTenantClientPhones } from './client-phone.service.js';
import { findOrCreateClient } from './tenant.service.js';
import { formatPhone } from '../utils/whatsapp-id.js';
import { simulateCustomerMessage } from './simulator.service.js';
process.env.GEMINI_API_KEY = '';
process.env.SUPABASE_URL = 'https://database.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';

const owner = '972500000002@c.us';
const customer = '261885798707406@lid';
const KB = readFileSync('src/services/fixtures/knowledge-base-structured.md', 'utf8');

async function fixture(behavior: Record<string, unknown> = {}) {
  const pg = await createTestDatabase();
  const db = pgliteDatabaseClient(pg);
  const tenantId = ((await db.from('tenants').insert({ name: 'Юрий', business_name: 'BizGenie', language: 'ru', tier: 'basic', status: 'active' }).select('id').single()).data as { id: string }).id;
  await pg.query("insert into notification_settings(tenant_id,owner_phone,owner_chat_id,mode,time_zone,auto_replies_paused,behavior) values($1,'972500000002',$2,'mute_all','Asia/Jerusalem',false,$3)", [tenantId, owner, JSON.stringify(behavior)]);
  await pg.query("insert into plans(code,display_name,messages_per_month,voice_minutes_per_month,warning_percent,unlimited) values('basic','Базовый',500,60,80,false) on conflict(code) do nothing");
  await pg.query("insert into tenant_usage_limits(tenant_id,plan,messages_per_month,voice_minutes_per_month,warning_percent,messages_overridden,voice_overridden,warning_overridden) values($1,'basic',500,60,80,false,false,false)", [tenantId]);
  await pg.query("insert into assistant_profiles(tenant_id,assistant_name,allowed_languages,tone) values($1,'Leya',array['ru'],'friendly_professional')", [tenantId]);
  await pg.query("insert into knowledge_documents(tenant_id,file_name,media_type,size_bytes,character_count,extracted_text,status,embedding_model,embedding_dimensions) values($1,'bizgenie-knowledge-base.md','text/markdown',$2::bigint,$2::integer,$3,'ready','gemini-embedding-001',768)", [tenantId, KB.length, KB]);
  const sent: { chatId: string; text: string; id: string }[] = [];
  const provider: WhatsAppProvider = {
    async getSessionStatus() { return { status: 'WORKING', me: { id: '972500000009@c.us', lid: '99999999@lid' } }; },
    async sendMessage(input) { const id = `true_${input.chatId}_MSG${sent.length}`; sent.push({ ...input, id }); return { id }; },
  };
  const incoming = (id: string, text: string) => ({ event: 'message', payload: { id, from: customer, fromMe: false, hasMedia: false, body: text, author: null, replyTo: null,
    _data: { Info: { PushName: 'Дана', Chat: customer, SenderAlt: '972501234567@s.whatsapp.net' } } } });
  const toOwner = () => sent.filter(m => m.chatId === owner);
  const toClient = () => sent.filter(m => m.chatId === customer);
  return { pg, db, tenantId, sent, provider, incoming, toOwner, toClient, async close() { await stopOutboundQueue(db); await pg.close(); } };
}
const classifier = '{"agent":"SALE","confidence":0.95}';

test('small base goes to the model whole: low-similarity units no longer escalate "какие услуги?"', async () => {
  const f = await fixture();
  try {
    const { handleWebhookEvent } = await import('../workers/webhook.worker.js');
    let materials: Array<{ source: string; text: string }> = [];
    const ai = { async generateReply(input: { systemPrompt: string; userMessage: string }) {
      if (input.systemPrompt.includes('классификатор')) return { text: classifier };
      materials = JSON.parse(input.userMessage).uploadedMaterials;
      assert.match(input.systemPrompt, /Общий вопрос/);
      return { text: '{"reply":"Мы делаем WhatsApp-ассистентов, сайты и автоматизацию. Что из этого вам интересно?","unanswered":[]}' };
    } };
    await handleWebhookEvent(f.tenantId, f.incoming('m1', 'какие услуги вы оказываете?'), f.db, f.provider, ai as never); await settleAllOutboundQueues();
    assert.deepEqual(materials, [{ source: 'bizgenie-knowledge-base.md', text: KB }]);
    assert.equal(f.toClient().at(-1)!.text, 'Мы делаем WhatsApp-ассистентов, сайты и автоматизацию. Что из этого вам интересно?');
    assert.equal(f.toOwner().length, 0);
    assert.equal((await f.pg.query<{ n: number }>('select count(*)::int n from escalations')).rows[0]!.n, 0);
    const usage = await f.pg.query<{ mode: string; chars: string }>("select metadata->>'knowledge_mode' mode,metadata->>'knowledge_chars' chars from usage_events where event_type='model_call' and metadata ? 'knowledge_mode'");
    assert.deepEqual(usage.rows, [{ mode: 'full', chars: String(KB.length) }]);
  } finally { await f.close(); }
});

test('a base above the full-context limit falls back to unit search', async () => {
  const f = await fixture({ knowledge_full_context_chars: 100 });
  try {
    const settings = await loadOwnerSettings(f.db, f.tenantId), context = await loadContext(f.db, f.tenantId);
    const calls: string[] = [];
    const result = await loadKnowledgeMaterials(f.db, f.tenantId, 'цена сайта', context, settings, async (_db, _t, q) => { calls.push(q); return [{ content: '## Сайты\nЛендинг — от 3000 ₪', file_name: 'kb.md', similarity: 0.6 }]; });
    assert.equal(result.mode, 'search'); assert.deepEqual(calls, ['цена сайта']);
    assert.equal(result.materials.length, 1);
  } finally { await f.close(); }
});

test('three questions, one answered from the base: one client message, two owner notifications, one combined answer, no service messages after', async () => {
  const f = await fixture();
  try {
    const { handleWebhookEvent } = await import('../workers/webhook.worker.js');
    const ai = { async generateReply(input: { systemPrompt: string; userMessage: string }) {
      if (input.systemPrompt.includes('классификатор')) return { text: classifier };
      if (input.systemPrompt.startsWith('Ты проверяющий')) return { text: '{"adds_facts":false,"changes_meaning":false}' };
      if (input.systemPrompt.startsWith('Ты ассистент владельца бизнеса. Владелец ответил')) return { text: 'Парковка есть во дворе. Оплата картой возможна.' };
      if (input.systemPrompt.includes('пополнять базу знаний')) return { text: '{"useful":false}' };
      return { text: '{"reply":"Лендинг стоит от 3000 ₪.","unanswered":["Есть ли парковка?","Можно оплатить картой?"]}' };
    } };
    await handleWebhookEvent(f.tenantId, f.incoming('m1', 'Сколько стоит лендинг? Есть ли парковка? Можно оплатить картой?'), f.db, f.provider, ai as never); await settleAllOutboundQueues();
    assert.equal(f.toClient().length, 1);
    assert.match(f.toClient()[0]!.text, /^Лендинг стоит от 3000 ₪\.\n\n/);
    assert.match(f.toClient()[0]!.text, /Уточню у владельца/);
    const notices = f.toOwner();
    assert.equal(notices.length, 2);
    assert.equal(notices[0]!.text, '❓ Дана (+972 50-123-4567):\n«Есть ли парковка?»\n\nОтветьте реплеем — я передам клиенту.');
    assert.match(notices[1]!.text, /«Можно оплатить картой\?»/);
    const esc = (await f.pg.query<{ owner_message_ids: string[] }>('select owner_message_ids from escalations order by batch_position')).rows;
    const settings = await loadOwnerSettings(f.db, f.tenantId);
    await handleOwnerMessage(f.db, f.provider, f.tenantId, 'session', owner, 'есть, во дворе', notices[0]!.id, settings, ai as never); await settleAllOutboundQueues();
    assert.equal(f.toClient().length, 1, 'first answer waits for the rest of the batch');
    assert.equal(esc.length, 2);
    await handleOwnerMessage(f.db, f.provider, f.tenantId, 'session', owner, 'да картой можно', notices[1]!.id, settings, ai as never); await settleAllOutboundQueues();
    assert.equal(f.toClient().length, 2);
    assert.equal(f.toClient()[1]!.text, 'Парковка есть во дворе. Оплата картой возможна.');
    assert.equal(f.toOwner().length, 2, 'zero service messages to the owner after answering');
    const statuses = (await f.pg.query<{ status: string; client_message_id: string }>('select status,client_message_id from escalations')).rows;
    assert.ok(statuses.every(r => r.status === 'delivered') && statuses[0]!.client_message_id === statuses[1]!.client_message_id);
  } finally { await f.close(); }
});

test('reminder deadline sends the answers already received and says the rest is being checked', async () => {
  const f = await fixture({ escalation_remind_minutes: 1, escalation_close_minutes: 600 });
  try {
    const { handleWebhookEvent } = await import('../workers/webhook.worker.js');
    const ai = { async generateReply(input: { systemPrompt: string }) {
      if (input.systemPrompt.includes('классификатор')) return { text: classifier };
      return { text: '{"reply":null,"unanswered":["Есть парковка?","Работаете в субботу?"]}' };
    } };
    await handleWebhookEvent(f.tenantId, f.incoming('m1', 'Есть парковка? Работаете в субботу?'), f.db, f.provider, ai as never); await settleAllOutboundQueues();
    const settings = await loadOwnerSettings(f.db, f.tenantId);
    await handleOwnerMessage(f.db, f.provider, f.tenantId, 'session', owner, 'Парковка есть', f.toOwner()[0]!.id, settings, null); await settleAllOutboundQueues();
    const { runEscalationTimeouts } = await import('./owner-workflow.service.js');
    await runEscalationTimeouts(f.db, () => f.provider, new Date(Date.now() + 5 * 60_000)); await settleAllOutboundQueues();
    const last = f.toClient().at(-1)!.text;
    assert.match(last, /Парковка есть/); assert.match(last, /По остальным вопросам ещё уточняю/);
    const rows = (await f.pg.query<{ question: string; status: string }>('select question,status from escalations order by batch_position')).rows;
    assert.deepEqual(rows.map(r => r.status), ['delivered', 'pending']);
  } finally { await f.close(); }
});

test('suggestions: only reusable answers, offered in the next summary, accepted by numbers, expire after three summaries', async () => {
  const f = await fixture({ summary_frequency: 'daily', summary_time: '00:00' });
  try {
    const judge = (useful: boolean, question = 'Сколько стоит лендинг?', answer = 'Лендинг стоит от 3000 ₪.') =>
      ({ async generateReply() { return { text: JSON.stringify({ useful, question, answer }) }; } });
    const conv = (await f.pg.query<{ id: string }>("with c as (insert into clients(tenant_id,phone,whatsapp_jid) values($1,null,$2) returning id) insert into conversations(tenant_id,client_id,status) select $1,id,'active' from c returning id", [f.tenantId, customer])).rows[0]!.id;
    const esc = async (q: string, a: string) => (await f.pg.query<{ id: string; tenant_id: string; question: string; answer: string }>("insert into escalations(tenant_id,conversation_id,client_chat_id,client_name,question,session,status,answer,client_message_id) values($1,$2,$3,'Дана',$4,'session','delivered',$5,'x') returning id,tenant_id,question,answer", [f.tenantId, conv, customer, q, a])).rows[0]!;
    assert.equal(await proposeKnowledgeSuggestion(f.db, await esc('А перезвоните?', 'перезвоню'), judge(false)), false);
    assert.equal(await proposeKnowledgeSuggestion(f.db, await esc('Лендинг почём?', 'от 3000 шекелей'), judge(true, 'Сколько стоит лендинг?', 'Лендинг — от 3000 шекелей.')), true);
    assert.equal(await proposeKnowledgeSuggestion(f.db, await esc('Скидка есть?', 'нет'), judge(true, 'Есть ли скидки?', 'Скидка 50% для всех.')), false, 'a new number in the answer is rejected');
    assert.equal(await proposeKnowledgeSuggestion(f.db, await esc('Где вы?', 'Ришон, Герцль 1'), judge(true, 'Где вы находитесь?', 'Ришон-ле-Цион, улица Герцль 1.')), true);
    await deliverOwnerSummaryIfDue(f.db, f.tenantId, 'session', f.provider, new Date()); await settleAllOutboundQueues();
    const summary = f.toOwner().at(-1)!;
    assert.match(summary.text, /Добавить в базу знаний\?\n1\. В: Сколько стоит лендинг\? — О: Лендинг — от 3000 шекелей\.\n2\. В: Где вы находитесь\?/);
    assert.doesNotMatch(summary.text, /Дана/);
    const settings = await loadOwnerSettings(f.db, f.tenantId);
    const before = f.sent.length;
    await handleOwnerMessage(f.db, f.provider, f.tenantId, 'session', owner, '2', summary.id, settings); await settleAllOutboundQueues();
    assert.equal(f.sent.length, before, 'no confirmation message');
    const decided = (await f.pg.query<{ question: string; status: string }>('select question,status from knowledge_suggestions order by created_at')).rows;
    assert.deepEqual(decided.map(r => r.status), ['rejected', 'accepted']);
    const items = (await f.pg.query<{ question: string; source: string }>("select question,source from knowledge_items where tenant_id=$1", [f.tenantId])).rows;
    assert.deepEqual(items, [{ question: 'Где вы находитесь?', source: 'owner_suggestion' }]);
    // Unanswered suggestions expire after three summaries.
    await proposeKnowledgeSuggestion(f.db, await esc('Часы?', 'с 9 до 18'), judge(true, 'Какие часы работы?', 'С 9 до 18.'));
    for (let day = 1; day <= 4; day++) {
      // Each iteration is a new day: drop the pre-scheduled next job so the day's summary can be claimed.
      await f.pg.query("delete from scheduled_jobs where job_type='owner_summary' and status='pending'");
      await deliverOwnerSummaryIfDue(f.db, f.tenantId, 'session', f.provider, new Date(Date.now() + day * 86_400_000)); await settleAllOutboundQueues();
    }
    const last = (await f.pg.query<{ status: string; offer_count: number }>("select status,offer_count from knowledge_suggestions where question='Какие часы работы?'")).rows[0]!;
    assert.deepEqual(last, { status: 'expired', offer_count: 3 });
    assert.doesNotMatch(f.toOwner().at(-1)!.text, /Добавить в базу знаний/, 'no block without suggestions');
  } finally { await f.close(); }
});

test('client phone: SenderAlt, then GOWS lids lookup (cached), never a lid; one client for @lid and @c.us', async () => {
  const f = await fixture();
  try {
    clearClientPhoneCache();
    let lookups = 0;
    const provider = { ...f.provider, async getLidPhone(_s: string, lid: string) { lookups++; return lid === '111@lid' ? '972509998877@c.us' : null; } } as WhatsAppProvider;
    assert.equal(await resolveClientPhone(provider, 's', '972501112233@c.us', null, 5), '972501112233');
    assert.equal(await resolveClientPhone(provider, 's', '222@lid', { payload: { _data: { Info: { SenderAlt: '972504445566@s.whatsapp.net' } } } }, 5), '972504445566');
    assert.equal(await resolveClientPhone(provider, 's', '111@lid', null, 5), '972509998877');
    assert.equal(await resolveClientPhone(provider, 's', '111@lid', null, 5), '972509998877');
    assert.equal(lookups, 1, 'lid lookups are cached');
    assert.equal(await resolveClientPhone(provider, 's', '333@lid', null, 5), null);
    const viaLid = await findOrCreateClient(f.db, f.tenantId, '972509998877', 'Мира', '111@lid');
    const viaPhone = await findOrCreateClient(f.db, f.tenantId, '972509998877', 'Мира', '972509998877@c.us');
    assert.equal(viaLid.id, viaPhone.id);
    const unknown = await findOrCreateClient(f.db, f.tenantId, null, null, '333@lid');
    assert.equal(unknown.phone, null);
    // Cards and notifications show the formatted real number; a lid is never presented as a phone.
    assert.equal(formatPhone(viaLid.phone), '+972 50-999-8877');
    assert.equal(formatPhone('111@lid'), null);
    assert.match(readFileSync('src/services/client-cards.service.ts', 'utf8'), /phone:formatPhone\(row\.phone\)/);
  } finally { await f.close(); }
});

test('resolve-phones backfill fills lid clients with pauses and reports counts', async () => {
  const f = await fixture();
  try {
    clearClientPhoneCache();
    await f.pg.query("insert into whatsapp_instances(tenant_id,waha_url,session_name,status) values($1,'http://localhost','tenant-session','WORKING')", [f.tenantId]);
    await f.pg.query("insert into clients(tenant_id,phone,whatsapp_jid) values($1,null,'111@lid'),($1,null,'222@lid'),($1,'972500000077','972500000077@c.us')", [f.tenantId]);
    const provider = { ...f.provider, async getLidPhone(_s: string, lid: string) { return lid === '111@lid' ? '972509998877@c.us' : null; } } as WhatsAppProvider;
    assert.deepEqual(await resolveTenantClientPhones(f.db, provider, f.tenantId, { pauseMs: 1, timeoutSeconds: 5 }), { checked: 2, resolved: 1, unresolved: 1 });
    const rows = (await f.pg.query<{ whatsapp_jid: string; phone: string | null }>('select whatsapp_jid,phone from clients order by whatsapp_jid')).rows;
    assert.deepEqual(rows, [{ whatsapp_jid: '111@lid', phone: '972509998877' }, { whatsapp_jid: '222@lid', phone: null }, { whatsapp_jid: '972500000077@c.us', phone: '972500000077' }]);
  } finally { await f.close(); }
});

test('simulator keeps the escalation waiting text in its history', async () => {
  const f = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'leya-sim-g-'));
  try {
    invalidateOwnerSettings(f.db, f.tenantId);
    const session = crypto.randomUUID();
    const ai = { async generateReply(input: { systemPrompt: string }) {
      if (input.systemPrompt.includes('классификатор')) return { text: classifier };
      return { text: '{"reply":null,"unanswered":["Есть парковка?"]}' };
    } };
    const result = await simulateCustomerMessage(f.db, f.tenantId, session, 'Есть парковка?', ai as never, { root });
    assert.equal(result.outcome, 'escalated');
    const rows = (await f.pg.query<{ from_me: boolean; body: string }>('select from_me,body from simulator_messages where session_id=$1 order by sequence', [session])).rows;
    assert.deepEqual(rows.map(r => r.from_me), [false, true]);
    assert.equal(rows[1]!.body, result.reply);
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});

test('merged client: escalation from @lid shows the number although the card keeps the old @c.us jid', async () => {
  const f = await fixture();
  try {
    const { handleWebhookEvent } = await import('../workers/webhook.worker.js');
    await f.pg.query("insert into clients(tenant_id,phone,whatsapp_jid,name) values($1,'972501234567','972501234567@c.us','Дана')", [f.tenantId]);
    const ai = { async generateReply(input: { systemPrompt: string }) {
      if (input.systemPrompt.includes('классификатор')) return { text: classifier };
      return { text: '{"reply":null,"unanswered":["Есть парковка?"]}' };
    } };
    await handleWebhookEvent(f.tenantId, f.incoming('m1', 'Есть парковка?'), f.db, f.provider, ai as never); await settleAllOutboundQueues();
    assert.equal((await f.pg.query<{ n: number }>('select count(*)::int n from clients where tenant_id=$1', [f.tenantId])).rows[0]!.n, 1, 'one client for both ids');
    assert.match(f.toOwner()[0]!.text, /^❓ Дана \(\+972 50-123-4567\):/);
    const esc = (await f.pg.query<{ client_phone: string; client_chat_id: string }>('select client_phone,client_chat_id from escalations')).rows[0]!;
    assert.deepEqual(esc, { client_phone: '972501234567', client_chat_id: customer });
    // Without the snapshot (rows created before 058) the number comes through conversation → client.
    await f.pg.query('update escalations set client_phone=null,reminded_at=null,pending_since=now()-interval \'3 hours\'');
    const { runEscalationTimeouts } = await import('./owner-workflow.service.js');
    await runEscalationTimeouts(f.db, () => f.provider, new Date()); await settleAllOutboundQueues();
    assert.match(f.toOwner().at(-1)!.text, /Напоминание: клиент Дана \(\+972 50-123-4567\) ждёт ответа/);
  } finally { await f.close(); }
});
