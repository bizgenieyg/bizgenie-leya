import assert from 'node:assert/strict';
import test from 'node:test';
import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { createTestDatabase, pgliteDatabaseClient } from './test-support/pglite-harness.js';
import { settleAllOutboundQueues, stopOutboundQueue } from '../workers/outbound-queue.js';
import { AIProviderError } from '../providers/ai/ai-provider.interface.js';
import { simulateCustomerMessage } from './simulator.service.js';
import { saveRuntimeSettings, readRuntimeSettings } from './runtime-settings.service.js';
import { invalidateOwnerSettings } from './owner-settings.service.js';
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
    assert.equal(f.toClient()[0]!.text, 'Здравствуйте, Марина! Это Гоша, цифровой ассистент. Чем могу помочь?');
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
    assert.equal(settings.greeting_template_defaults['client.greeting']!.ru, 'Здравствуйте{, client_first_name}! Это {assistant_name}, цифровой ассистент. Чем могу помочь?');
    // A stored copy of the old default is shown as "not edited", so the cabinet offers the new default.
    await f.pg.query(`update notification_settings set templates=jsonb_build_object('client.greeting',jsonb_build_object('ru','Здравствуйте! Это {assistant_name}, ассистент {owner_name}. Чем могу помочь?')) where tenant_id=$1`, [f.tenantId]);
    invalidateOwnerSettings(f.db, f.tenantId);
    assert.deepEqual((await readRuntimeSettings(f.db, f.tenantId)).greeting_templates['client.greeting'], {});
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

test('history answers discovery question 1 → the gate offers question 2; all answered → no discovery block', async () => {
  const f = await fixture();
  try {
    const qs = ['Чем занимается бизнес и сколько в нём человек?', 'Откуда приходят клиенты: WhatsApp, Instagram, сайт, рекомендации?'];
    const session = crypto.randomUUID();
    const history = [{ fromMe: false, text: 'У меня салон красоты, нас трое.', createdAt: '2026-09-01T10:00:00Z' }, { fromMe: true, text: 'Понял, спасибо.', createdAt: '2026-09-01T10:05:00Z' }];
    f.reply({ intent: 'sale', facts: [{ fact: 'салон красоты, трое сотрудников', answers_question: 1 }] },
      { reply: 'Подключение 1500 ₪.', unanswered: [], intent: 'sale' },
      { reply: 'Работает с вашим номером.', unanswered: [], asked_question: true });
    await simulateCustomerMessage(f.db, f.tenantId, session, 'сколько стоит?', f.ai as never, { evaluation: { history } });
    await simulateCustomerMessage(f.db, f.tenantId, session, 'а как подключается?', f.ai as never, { evaluation: {} });
    const last = f.prompts.at(-1)!;
    assert.ok(last.includes(JSON.stringify(qs[1])), 'question 2 is offered');
    assert.ok(!last.includes(`в конце задай своими словами один вопрос: ${JSON.stringify(qs[0])}`), 'question 1 is known from history');
    assert.doesNotMatch(last, /question_known/);
    const state = (await f.pg.query<{ dialog_state: Record<string, unknown> }>('select dialog_state from simulator_sessions where id=$1', [session])).rows[0]!.dialog_state;
    assert.equal((state.discovery_answered as string[]).length, 1);
    assert.deepEqual(state.discovery_asked, [qs[1]]);
  } finally { await f.close(); }
});

test('no model key: "какие услуги?" escalates as an outage (missing_api_key), never as missing knowledge', async () => {
  const f = await fixture();
  try {
    const { createAIProvider } = await import('../providers/ai/index.js');
    const { handleWebhookEvent } = await import('../workers/webhook.worker.js');
    const { resetModelHealth } = await import('./model-health.service.js');
    const alerts: string[] = [];
    resetModelHealth(async kind => { alerts.push(kind); return true; });
    for (const [id, text] of [['m1', 'какие услуги?'], ['m2', 'а сколько стоит?'], ['m3', 'можно записаться?']] as const)
      await handleWebhookEvent(f.tenantId, { event: 'message', payload: { id, from: chat, fromMe: false, hasMedia: false, body: text, author: null, replyTo: null,
        _data: { Info: { PushName: 'Марина', Chat: chat } } } }, f.db, { ...({} as WhatsAppProvider), async getSessionStatus() { return { status: 'WORKING', me: { id: '972500000009@c.us' } }; },
        async sendMessage(input) { f.sent.push({ ...input, id: `x${f.sent.length}` }); return { id: `x${f.sent.length}` }; } }, createAIProvider(''));
    await settleAllOutboundQueues();
    const escalations = (await f.pg.query<{ model_unavailable: boolean }>('select model_unavailable from escalations')).rows;
    assert.ok(escalations.length >= 1 && escalations.every(r => r.model_unavailable));
    assert.equal((await f.pg.query<{ n: number }>("select count(*)::int n from agent_actions where action_type='knowledge_missing'")).rows[0]!.n, 0);
    assert.equal((await f.pg.query<{ n: number }>('select count(*)::int n from knowledge_suggestions')).rows[0]!.n, 0);
    const reasons = (await f.pg.query<{ reason: string }>("select distinct metadata->>'failure_reason' reason from usage_events where event_type='model_call'")).rows.map(r => r.reason);
    assert.deepEqual(reasons, ['missing_api_key']);
    assert.ok(alerts.includes('model_down'), 'counted by the model health alert');
    resetModelHealth();
  } finally { await f.close(); }
});

// Task Q: an owner request only after a direct request or the client's "yes" to an offer.
const requests = async (f: Awaited<ReturnType<typeof fixture>>) => Number((await f.pg.query<{ n: string }>("select count(*)::text as n from escalations where kind='request'")).rows[0]!.n);

test('"по объявлениям" is not a request: the assistant asks for consent (and a name); "да" creates it without a model call', async () => {
  const f = await fixture();
  try {
    f.reply({ reply: 'Ассистент сам ответит тем, кто пишет по объявлению, даже ночью. Это вам подходит?', unanswered: [], intent: 'sale',
      request: { summary: 'Клиенты приходят по объявлениям, хочет автоматизацию', topic: 'ответы клиентам по объявлениям', time: null } });
    await f.send('m1', 'по объявлениям', 'Мама');
    assert.equal(await requests(f), 0, 'no request without consent');
    const offer = f.toClient().at(-1)!.text;
    assert.match(offer, /^Ассистент сам ответит тем, кто пишет по объявлению, даже ночью\./);
    assert.match(offer, /Передать Юрия, чтобы связался с вами по поводу «ответы клиентам по объявлениям»\? И как к вам обращаться\?$/);
    assert.doesNotMatch(offer, /Мама|подходит\?/, 'the model question is dropped, "Мама" is never a name');
    assert.equal(((await f.state()).pending_offer as { turns_left: number }).turns_left, 2);
    const calls = f.prompts.length;
    await f.send('m2', 'да, Аня', 'Мама');
    assert.equal(f.prompts.length, calls, 'consent needs no model call');
    assert.equal(await requests(f), 1);
    assert.equal(f.toClient().at(-1)!.text, 'Спасибо, Аня! Передала вашу заявку — Юрия свяжется с вами.');
    assert.equal((await f.state()).pending_offer, undefined);
    assert.equal((await f.pg.query<{ preferred_name: string; preferred_name_source: string }>('select preferred_name,preferred_name_source from clients')).rows[0]!.preferred_name, 'Аня');
  } finally { await f.close(); }
});

test('"хочу демо" is a direct request: created at once; "не надо звонить" is not', async () => {
  const f = await fixture();
  try {
    f.reply({ reply: null, unanswered: [], intent: 'sale', request: { summary: 'Не надо звонить', time: null } });
    await f.send('m1', 'не надо звонить, просто напишите');
    assert.equal(await requests(f), 0);
    f.reply({ reply: null, unanswered: [], intent: 'sale', request: { summary: 'Хочет демо', time: null } });
    await f.send('m2', 'хочу демо');
    assert.equal(await requests(f), 1);
    assert.equal(f.toClient().at(-1)!.text, 'Спасибо, Марина! Передала вашу заявку — Юрия свяжется с вами.');
  } finally { await f.close(); }
});

test('"нет" to the offer: no request and no second offer; an unanswered offer lapses after two client turns', async () => {
  const f = await fixture();
  try {
    const wants = { reply: 'Покажу, как это выглядит у вас.', unanswered: [], intent: 'sale', request: { summary: 'Интерес к ассистенту', topic: 'ассистент', time: null } };
    f.reply(wants);
    await f.send('m1', 'интересно');
    assert.ok((await f.state()).pending_offer);
    f.reply({ reply: 'Хорошо, если появятся вопросы — пишите.', unanswered: [], intent: 'sale' });
    await f.send('m2', 'нет, не сейчас');
    assert.equal((await f.state()).offer_declined, true);
    assert.equal((await f.state()).pending_offer, undefined);
    f.reply({ ...wants, reply: 'Подключение 1500 ₪.' });
    await f.send('m3', 'а цена какая');
    assert.equal(f.toClient().at(-1)!.text, 'Подключение 1500 ₪.', 'no second offer after a decline');
    assert.equal(await requests(f), 0);

    const g = await fixture();
    try {
      g.reply(wants);
      await g.send('m1', 'интересно');
      g.reply({ reply: 'Работает в WhatsApp.', unanswered: [], intent: 'sale' }, { reply: 'Настройка за день.', unanswered: [], intent: 'sale' });
      await g.send('m2', 'а как это работает');
      assert.equal(((await g.state()).pending_offer as { turns_left: number }).turns_left, 1);
      await g.send('m3', 'а сколько настраивать');
      assert.equal((await g.state()).pending_offer, undefined, 'lapsed after two client turns');
      await g.send('m4', 'да');
      assert.equal(await requests(g), 0, 'a late "да" is not consent');
    } finally { await g.close(); }
  } finally { await f.close(); }
});

test('a paraphrased repeat of one of the last three replies (27.09 dialog) is regenerated once, then goes to the owner', async () => {
  const f = await fixture();
  try {
    const session = crypto.randomUUID();
    // Fixture embeddings: the two "напишите «хочу демо»" calls from the 27.09 dialog are near-identical in meaning.
    const vectors: Record<string, number[]> = {
      'Мы делаем ассистента, который отвечает клиентам в WhatsApp. Напишите «хочу демо», и мы покажем.': [1, 0, 0],
      'Если интересно посмотреть, как это работает, просто напишите «хочу демо».': [0.97, 0.24, 0],
      'Для аренды авто ассистент ответит на вопросы о цене и свободных машинах сразу, даже ночью.': [0.2, 0.1, 0.97],
    };
    const embedder = { model: 'fixture', dimensions: 3, async embed(texts: string[]) { return { vectors: texts.map(t => vectors[t] ?? [0, 1, 0]) }; } };
    const run = (text: string) => simulateCustomerMessage(f.db, f.tenantId, session, text, f.ai as never, { evaluation: {}, embedder });
    f.reply({ reply: 'Мы делаем ассистента, который отвечает клиентам в WhatsApp. Напишите «хочу демо», и мы покажем.', unanswered: [], intent: 'unknown' });
    await run('чем вы занимаетесь?');
    f.reply({ reply: 'Если интересно посмотреть, как это работает, просто напишите «хочу демо».', unanswered: [], intent: 'unknown' },
      { reply: 'Для аренды авто ассистент ответит на вопросы о цене и свободных машинах сразу, даже ночью.', unanswered: [], intent: 'unknown' });
    const second = await run('у меня аренда авто, а как это мне поможет?');
    assert.equal(second.reply, 'Для аренды авто ассистент ответит на вопросы о цене и свободных машинах сразу, даже ночью.');
    assert.match(f.prompts.at(-1)!, /НЕ ПОВТОРЯЙСЯ/);
    f.reply({ reply: 'Если интересно посмотреть, как это работает, просто напишите «хочу демо».', unanswered: [], intent: 'unknown' },
      { reply: 'Если интересно посмотреть, как это работает, просто напишите «хочу демо».', unanswered: [], intent: 'unknown' });
    const third = await run('а что ещё он умеет?');
    assert.equal(third.outcome, 'escalated', 'still a repeat after one regeneration: to the owner, never sent');
    const events = await f.pg.query<{ n: string }>("select count(*)::text as n from usage_events where event_type='embedding_call' and metadata->>'purpose'='repeat_check'");
    assert.ok(Number(events.rows[0]!.n) >= 1, 'embedding calls are metered, not billable');
  } finally { await f.close(); }
});

test('a broken embedding never blocks the reply', async () => {
  const f = await fixture();
  try {
    const session = crypto.randomUUID();
    const embedder = { model: 'fixture', dimensions: 3, async embed(): Promise<never> { throw new Error('down'); } };
    f.reply({ reply: 'Первый ответ.', unanswered: [] });
    await simulateCustomerMessage(f.db, f.tenantId, session, 'вопрос один', f.ai as never, { evaluation: {}, embedder });
    f.reply({ reply: 'Второй ответ про другое.', unanswered: [] });
    const r = await simulateCustomerMessage(f.db, f.tenantId, session, 'вопрос два', f.ai as never, { evaluation: {}, embedder });
    assert.equal(r.reply, 'Второй ответ про другое.');
  } finally { await f.close(); }
});

test('meaning-only repeat (no shared call to action, different words) is caught by embeddings and regenerated', async () => {
  const f = await fixture();
  try {
    const session = crypto.randomUUID();
    const a = 'Ассистент сам отвечает вашим клиентам круглые сутки.', b = 'Он круглосуточно и без вас ведёт переписку с покупателями.', c = 'Подключение занимает один день.';
    const vectors: Record<string, number[]> = { [a]: [1, 0, 0], [b]: [0.95, 0.31, 0], [c]: [0, 0, 1] };
    const embedder = { model: 'fixture', dimensions: 3, async embed(texts: string[]) { return { vectors: texts.map(t => vectors[t] ?? [0, 1, 0]) }; } };
    const run = (text: string) => simulateCustomerMessage(f.db, f.tenantId, session, text, f.ai as never, { evaluation: {}, embedder });
    f.reply({ reply: a, unanswered: [] });
    await run('что делает ассистент?');
    f.reply({ reply: b, unanswered: [] }, { reply: c, unanswered: [] });
    const second = await run('а подробнее?');
    assert.equal(second.reply, c);
    assert.match(f.prompts.at(-1)!, /НЕ ПОВТОРЯЙСЯ[^\n]*Ассистент сам отвечает/);
  } finally { await f.close(); }
});

test('the name the client gave lives on the client: it wins over "Мама" and survives a new conversation (062)', async () => {
  const f = await fixture();
  try {
    f.reply({ reply: 'Приятно познакомиться! Подключение 1500 ₪.', unanswered: [], intent: 'sale', client_name: 'Аня' });
    await f.send('m1', 'я Аня, сколько стоит ассистент?', 'Мама');
    const row = (await f.pg.query<{ preferred_name: string; preferred_name_source: string }>('select preferred_name,preferred_name_source from clients')).rows[0]!;
    assert.deepEqual([row.preferred_name, row.preferred_name_source], ['Аня', 'client']);
    assert.equal((await f.state()).client_name, undefined, 'not kept in dialog_state');
    // A new conversation (e.g. after the old one closed) still greets by the given name.
    await f.pg.query("update conversations set status='closed', dialog_state='{}'::jsonb");
    await f.send('m2', 'привет', 'Мама');
    assert.equal(Number((await f.pg.query<{ n: string }>('select count(*)::text as n from conversations')).rows[0]!.n), 2, 'a new conversation');
    assert.match(f.toClient().at(-1)!.text, /^Здравствуйте, Аня!/);
    // A model "name" with digits or a link is not saved.
    f.reply({ reply: 'Ок.', unanswered: [], intent: 'sale', client_name: 'anya.com' });
    await f.send('m3', 'а что входит?', 'Мама');
    assert.equal((await f.pg.query<{ preferred_name: string }>('select preferred_name from clients')).rows[0]!.preferred_name, 'Аня');
  } finally { await f.close(); }
});

test('062 moves names kept in dialog_state to clients.preferred_name and drops them from the state', async () => {
  const { readFileSync } = await import('node:fs');
  const f = await fixture();
  try {
    await f.send('m1', 'привет', 'Мама');
    await f.pg.query("update clients set preferred_name=null, preferred_name_source=null");
    await f.pg.query(`update conversations set dialog_state = dialog_state || '{"client_name":"Аня"}'::jsonb`);
    const sql = readFileSync('supabase/migrations/20260928090000_062_client_preferred_name.sql', 'utf8').replace(/^begin;|commit;$/gm, '');
    await f.pg.exec(sql.slice(sql.indexOf('update public.clients')));
    assert.deepEqual((await f.pg.query('select preferred_name,preferred_name_source from clients')).rows, [{ preferred_name: 'Аня', preferred_name_source: 'client' }]);
    assert.equal((await f.state()).client_name, undefined);
  } finally { await f.close(); }
});
