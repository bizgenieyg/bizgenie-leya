import assert from 'node:assert/strict';
import test from 'node:test';
import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { createTestDatabase, pgliteDatabaseClient } from './test-support/pglite-harness.js';
import { settleAllOutboundQueues, stopOutboundQueue } from '../workers/outbound-queue.js';
import { AIProviderError } from '../providers/ai/ai-provider.interface.js';
import { simulateCustomerMessage } from './simulator.service.js';
import { saveRuntimeSettings, readRuntimeSettings } from './runtime-settings.service.js';
process.env.GEMINI_API_KEY = '';
process.env.SUPABASE_URL = 'https://database.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';

const owner = '972500000002@c.us';
const chat = '261885798707406@lid';
async function fixture(options: { sector?: string } = {}) {
  const pg = await createTestDatabase();
  const db = pgliteDatabaseClient(pg);
  const tenantId = ((await db.from('tenants').insert({ name: 'Юрия', business_name: 'BizGenie', language: 'ru', tier: 'basic', status: 'active', business_sector: options.sector ?? 'автоматизация' }).select('id').single()).data as { id: string }).id;
  await pg.query("insert into notification_settings(tenant_id,owner_phone,owner_chat_id,mode,time_zone,auto_replies_paused) values($1,'972500000002',$2,'mute_all','Asia/Jerusalem',false)", [tenantId, owner]);
  await pg.query("insert into plans(code,display_name,messages_per_month,voice_minutes_per_month,warning_percent,unlimited) values('basic','Базовый',500,60,80,false) on conflict(code) do nothing");
  await pg.query("insert into tenant_usage_limits(tenant_id,plan,messages_per_month,voice_minutes_per_month,warning_percent,messages_overridden,voice_overridden,warning_overridden) values($1,'basic',500,60,80,false,false,false)", [tenantId]);
  await pg.query("insert into assistant_profiles(tenant_id,assistant_name,allowed_languages,tone) values($1,'Гоша',array['ru'],'friendly_professional')", [tenantId]);
  await pg.query("insert into knowledge_items(tenant_id,type,question,answer,active) values($1,'faq','Сколько стоит ассистент?','Подключение 1500 ₪.',true)", [tenantId]);
  const sent: { chatId: string; text: string; id: string }[] = [];
  const provider: WhatsAppProvider = {
    async getSessionStatus() { return { status: 'WORKING', me: { id: '972500000009@c.us', lid: '99999999@lid' } }; },
    async sendMessage(input) { const id = `true_${input.chatId}_MSG${sent.length}`; sent.push({ ...input, id }); return { id }; },
  };
  const prompts: string[] = [];
  let replies: Array<Record<string, unknown> | Error> = [];
  const ai = { async generateReply(input: { systemPrompt: string }) {
    prompts.push(input.systemPrompt);
    const next = replies.shift() ?? { reply: 'Ок.', unanswered: [] };
    if (next instanceof Error) throw next;
    return { text: JSON.stringify(next) };
  } };
  const send = async (id: string, text: string, name = 'Марина Иванова') => {
    const { handleWebhookEvent } = await import('../workers/webhook.worker.js');
    await handleWebhookEvent(tenantId, { event: 'message', payload: { id, from: chat, fromMe: false, hasMedia: false, body: text, author: null, replyTo: null,
      _data: { Info: { PushName: name, Chat: chat, SenderAlt: '972501234567@s.whatsapp.net' } } } }, db, provider, ai as never);
    await settleAllOutboundQueues();
  };
  const state = async () => (await pg.query<{ dialog_state: Record<string, unknown> }>('select dialog_state from conversations')).rows[0]?.dialog_state ?? {};
  return { pg, db, tenantId, sent, prompts, ai, send, state, reply: (...r: Array<Record<string, unknown> | Error>) => { replies = r; },
    toClient: () => sent.filter(m => m.chatId === chat), toOwner: () => sent.filter(m => m.chatId === owner), async close() { await stopOutboundQueue(db); await pg.close(); } };
}

test('bare greeting: owner template, zero model calls; the known client gets the short form with the first name', async () => {
  const f = await fixture();
  try {
    await f.send('m1', 'Привет!');
    assert.equal(f.prompts.length, 0);
    assert.equal(f.toClient()[0]!.text, 'Здравствуйте! Это Гоша, ассистент Юрия. Чем могу помочь?');
    assert.equal((await f.state()).stage, 'intent_unknown');
    assert.equal((await f.state()).client_turns, 0);
    await f.send('m2', 'добрый вечер');
    assert.equal(f.prompts.length, 0);
    assert.equal(f.toClient()[1]!.text, 'Здравствуйте, Марина! Чем могу помочь?');
    await f.send('m3', 'שלום');
    assert.match(f.toClient()[2]!.text, /במה אפשר לעזור\?$/);
  } finally { await f.close(); }
});

test('thanks / ok / 👍: fixed reply without the model, then silence instead of repeating it', async () => {
  const f = await fixture();
  try {
    await f.send('m1', 'спасибо');
    await f.send('m2', '👍');
    assert.equal(f.prompts.length, 0);
    assert.deepEqual(f.toClient().map(m => m.text), ['Пожалуйста! Если появятся вопросы — пишите.']);
  } finally { await f.close(); }
});

test('one model call per message: reception returns the intent, which then sticks; a strong opposite signal switches', async () => {
  const f = await fixture();
  try {
    f.reply({ reply: 'Мы делаем WhatsApp-ассистентов. Что для вас сейчас актуально?', unanswered: [], intent: 'sale' });
    await f.send('m1', 'Привет, хочу узнать про вас');
    assert.equal(f.prompts.length, 1);
    assert.match(f.prompts[0]!, /НАМЕРЕНИЕ/);
    assert.match(f.toClient()[0]!.text, /^Мы делаем/);
    let state = await f.state();
    assert.deepEqual([state.stage, state.intent, state.client_turns], ['intent_known', 'sale', 1]);
    assert.equal((await f.pg.query<{ routed_agent: string }>('select routed_agent from conversations')).rows[0]!.routed_agent, 'SALE');
    f.reply({ reply: 'Подключение 1500 ₪, работает с вашим номером.', unanswered: [] });
    await f.send('m2', 'а как подключается?');
    assert.equal(f.prompts.length, 2, 'no classifier call for the sticky intent');
    assert.doesNotMatch(f.prompts[1]!, /НАМЕРЕНИЕ/);
    f.reply({ reply: 'Сейчас разберёмся с оплатой.', unanswered: [] });
    await f.send('m3', 'а у меня ещё проблема с оплатой, не работает');
    state = await f.state();
    assert.equal(state.intent, 'support');
    assert.equal(f.prompts.length, 3);
  } finally { await f.close(); }
});

test('"Привет, сколько стоит…" drops the greeting and answers the question', async () => {
  const f = await fixture();
  try {
    f.reply({ reply: 'Подключение 1500 ₪.', unanswered: [], intent: 'sale' });
    await f.send('m1', 'Привет, сколько стоит бот для салона?');
    assert.equal(f.prompts.length, 1);
    assert.equal(f.toClient()[0]!.text, 'Подключение 1500 ₪.');
    const user = (await f.pg.query<{ body: string }>('select body from messages where from_me=false')).rows[0]!.body;
    assert.equal(user, 'Привет, сколько стоит бот для салона?', 'the stored message stays as sent');
  } finally { await f.close(); }
});

test('more than one question: one regeneration, then the reply is cut after the first question', async () => {
  const f = await fixture();
  try {
    f.reply({ reply: 'Стоит от 1500 ₪. Для какого бизнеса? И сколько сотрудников?', unanswered: [], intent: 'sale' },
      { reply: 'Стоит от 1500 ₪. Для какого бизнеса? И сколько сотрудников?', unanswered: [], intent: 'sale' });
    await f.send('m1', 'сколько стоит?');
    assert.equal(f.prompts.length, 2);
    assert.match(f.prompts[1]!, /НЕ БОЛЬШЕ ОДНОГО ВОПРОСА/);
    assert.equal(f.toClient()[0]!.text, 'Стоит от 1500 ₪. Для какого бизнеса?');
  } finally { await f.close(); }
});

test('model outage: escalation flagged for the owner, no missing-knowledge record, failure reason in usage', async () => {
  const f = await fixture();
  try {
    f.reply(new AIProviderError('down', undefined, { reason: 'http_403', httpStatus: 403 }));
    await f.send('m1', 'Сколько стоит лендинг под ключ?');
    assert.match(f.toClient()[0]!.text, /Уточню у владельца/);
    assert.match(f.toOwner()[0]!.text, /\(ассистент был недоступен\)$/);
    assert.equal((await f.pg.query<{ n: number }>("select count(*)::int n from agent_actions where action_type='knowledge_missing'")).rows[0]!.n, 0);
    assert.equal((await f.pg.query<{ m: boolean }>('select model_unavailable m from escalations')).rows[0]!.m, true);
    const failed = (await f.pg.query<{ reason: string }>("select metadata->>'failure_reason' reason from usage_events where event_type='model_call' and metadata->>'status'='failed'")).rows;
    assert.deepEqual(failed.map(r => r.reason), ['http_403']);
  } finally { await f.close(); }
});

test('owner greeting templates are editable in the cabinet and can be reset to default', async () => {
  const f = await fixture();
  try {
    await saveRuntimeSettings(f.db, f.tenantId, { greeting_templates: { 'client.greeting': { ru: 'Привет! Я {assistant_name}, пишите.' } } });
    let settings = await readRuntimeSettings(f.db, f.tenantId);
    assert.deepEqual(settings.greeting_templates['client.greeting'], { ru: 'Привет! Я {assistant_name}, пишите.' });
    await f.send('m1', 'привет');
    assert.equal(f.toClient()[0]!.text, 'Привет! Я Гоша, пишите.');
    await assert.rejects(saveRuntimeSettings(f.db, f.tenantId, { greeting_templates: { 'client.greeting': { ru: 'Привет {unknown}' } } }), /Invalid greeting templates/);
    await assert.rejects(saveRuntimeSettings(f.db, f.tenantId, { greeting_templates: { 'client.limit': { ru: 'x' } } }), /Invalid greeting templates/);
    await saveRuntimeSettings(f.db, f.tenantId, { greeting_templates: { 'client.greeting': {} } });
    settings = await readRuntimeSettings(f.db, f.tenantId);
    assert.deepEqual(settings.greeting_templates['client.greeting'], {});
    assert.equal(settings.greeting_template_defaults['client.greeting']!.ru, 'Здравствуйте! Это {assistant_name}, ассистент {owner_name}. Чем могу помочь?');
  } finally { await f.close(); }
});

test('simulator: the same path; dialogue state per session, history analysed once into the profile', async () => {
  const f = await fixture();
  try {
    const session = crypto.randomUUID();
    const first = await simulateCustomerMessage(f.db, f.tenantId, session, 'привет', f.ai as never, { evaluation: {
      history: [{ fromMe: false, text: 'Сделаете лендинг для кейтеринга?', createdAt: '2026-09-01T10:00:00Z' }, { fromMe: true, text: 'Да, пришлите меню.', createdAt: '2026-09-01T10:05:00Z' }] } });
    f.reply({ intent: 'sale', facts: ['заказывал лендинг для кейтеринга', 'пишет на «вы»'] });
    assert.equal(first.trace?.stage, 'intent_unknown');
    const session2 = crypto.randomUUID();
    f.reply({ intent: 'sale', facts: ['заказывал лендинг для кейтеринга', 'пишет на «вы»'] });
    const known = await simulateCustomerMessage(f.db, f.tenantId, session2, 'привет', f.ai as never, { evaluation: {
      history: [{ fromMe: false, text: 'Сделаете лендинг для кейтеринга?', createdAt: '2026-09-01T10:00:00Z' }, { fromMe: true, text: 'Да, пришлите меню.', createdAt: '2026-09-01T10:05:00Z' }] } });
    assert.equal(known.reply, 'Здравствуйте! Чем могу помочь?', 'known by history: no second introduction');
    assert.equal(known.trace?.intent, 'sale');
    const row = (await f.pg.query<{ profile_md: string; dialog_state: Record<string, unknown> }>('select profile_md,dialog_state from simulator_sessions where id=$1', [session2])).rows[0]!;
    assert.match(row.profile_md, /заказывал лендинг для кейтеринга/);
    assert.equal(row.dialog_state.history_analyzed, true);
    f.reply({ reply: 'Лендинг — от 3000 ₪.', unanswered: [] });
    await simulateCustomerMessage(f.db, f.tenantId, session2, 'а сколько стоит?', f.ai as never, { evaluation: {} });
    assert.equal(f.prompts.filter(p => p.includes('прошлая переписка')).length, 2, 'once per session, not per message');
    const fresh = crypto.randomUUID();
    const reset = await simulateCustomerMessage(f.db, f.tenantId, fresh, 'привет', f.ai as never, { evaluation: {} });
    assert.equal(reset.trace?.client_turns, 0);
  } finally { await f.close(); }
});
