import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, pgliteDatabaseClient } from './test-support/pglite-harness.js';
import { simulateCustomerMessage } from './simulator.service.js';
import { readRuntimeSettings, saveRuntimeSettings } from './runtime-settings.service.js';
import { BEHAVIOR_DEFAULTS } from '../config/behavior.js';
import { activateInstruction, uploadInstruction } from './instructions.service.js';
import { AIProviderError } from '../providers/ai/ai-provider.interface.js';

process.env.GEMINI_API_KEY = '';
process.env.SUPABASE_URL = 'https://database.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';

const INSTRUCTION = 'ИНСТРУКЦИЯ БИЗНЕСА: {business_name}. Юрия зовут {owner_name}. Встреча: [[REQUEST: meeting | topic=…]].';
async function fixture(options: { owner?: string; engine?: 'instruction' | 'legacy'; instruction?: string | null; languages?: string[] } = {}) {
  const pg = await createTestDatabase();
  const db = pgliteDatabaseClient(pg);
  const tenantId = ((await db.from('tenants').insert({ name: options.owner ?? 'Юрий', business_name: 'BizGenie', language: 'ru', tier: 'basic', status: 'active', business_sector: 'автоматизация бизнеса' }).select('id').single()).data as { id: string }).id;
  await pg.query("insert into notification_settings(tenant_id,owner_phone,owner_chat_id,mode,time_zone,auto_replies_paused) values($1,'972500000002','972500000002@c.us','mute_all','Asia/Jerusalem',false)", [tenantId]);
  await pg.query("insert into plans(code,display_name,messages_per_month,voice_minutes_per_month,warning_percent,unlimited) values('basic','Базовый',500,60,80,false) on conflict(code) do nothing");
  await pg.query("insert into tenant_usage_limits(tenant_id,plan,messages_per_month,voice_minutes_per_month,warning_percent,messages_overridden,voice_overridden,warning_overridden) values($1,'basic',500,60,80,false,false,false)", [tenantId]);
  await pg.query("insert into assistant_profiles(tenant_id,assistant_name,allowed_languages,tone) values($1,'Лея',$2::text[],'friendly_professional')", [tenantId, options.languages ?? ['ru']]);
  await pg.query("insert into business_facts(tenant_id,topic,text,status,created_by) values($1,'services_prices','Базовый ассистент — от 249 ₪ в месяц, установка от 500 ₪.','active','migration')", [tenantId]);
  // The model under test is the injected one (reply_model '' → the caller's model), no fallback.
  await saveRuntimeSettings(db, tenantId, { reply_engine: options.engine ?? 'instruction', reply_model: '', reply_fallback_model: '' });
  if (options.instruction !== null) { await uploadInstruction(db, { kind: 'business', tenantId }, options.instruction ?? INSTRUCTION); await activateInstruction(db, { kind: 'business', tenantId }, 1); }
  const prompts: Array<{ system: string; user: string; history: number }> = [];
  let replies: string[] = [];
  const ai = { async generateReply(input: { systemPrompt: string; userMessage: string; history?: unknown[] }) {
    prompts.push({ system: input.systemPrompt, user: input.userMessage, history: input.history?.length ?? -1 });
    const text = replies.shift() ?? 'Хорошо.';
    if (text.startsWith('THROW:')) throw new AIProviderError('Gemini reply unavailable', undefined, { reason: text.slice(6) });
    return { text };
  } };
  const session = crypto.randomUUID();
  const say = (text: string) => simulateCustomerMessage(db, tenantId, session, text, ai as never, { evaluation: {}, embedder: null });
  const requests = async () => Number((await pg.query<{ n: string }>("select count(*)::text as n from simulator_sessions where open_request is not null")).rows[0]!.n);
  return { pg, db, tenantId, prompts, say, requests, reply: (...r: string[]) => { replies = r; } };
}

test('instruction path: core + instruction + facts in the prompt, history as chat, labels never reach the client', async () => {
  const f = await fixture();
  try {
    f.reply('Здравствуйте! Чем занимается ваш бизнес?');
    await f.say('привет');
    f.reply('Для салона ассистент возьмёт на себя запись. Показать на примере, как он ответит вашей клиентке?\n[[OFFER: показать на примере]]\n[[BOOK: x]]');
    const second = await f.say('у меня салон красоты');
    assert.equal(second.reply, 'Для салона ассистент возьмёт на себя запись. Показать на примере, как он ответит вашей клиентке?');
    const p = f.prompts.at(-1)!;
    assert.match(p.system, /^Ты — Лея, ассистент бизнеса «BizGenie» в WhatsApp\. Владелец — Юрий\./);
    assert.match(p.system, /=== ИНСТРУКЦИЯ БИЗНЕСА ===\nИНСТРУКЦИЯ БИЗНЕСА: BizGenie\. Юрия зовут Юрий\./);
    assert.match(p.system, /=== ФАКТЫ ===\n## услуги и цены\n- Базовый ассистент — от 249 ₪ в месяц/);
    assert.equal(p.user, 'у меня салон красоты');
    assert.equal(p.history, 2, 'previous turns as chat messages, not JSON');
    assert.doesNotMatch(p.system, /Верни строго JSON|классификатор/);
  } finally { await f.pg.close(); }
});

test('27.09: "по объявлениям" — a REQUEST without consent is regenerated; if it stays, no request and no "свяжется"', async () => {
  const f = await fixture();
  try {
    f.reply('Отлично, Юрий свяжется с вами.\n[[REQUEST: meeting | topic=объявления]]', 'Юрий свяжется с вами сегодня.\n[[REQUEST: meeting | topic=объявления]]');
    const r = await f.say('по объявлениям');
    assert.equal(await f.requests(), 0);
    assert.match(f.prompts.at(-1)!.system, /Клиент не просил и не соглашался/);
    assert.doesNotMatch(r.reply ?? '', /свяжется|передал/);
    assert.equal(r.reply, 'Подскажите, пожалуйста, что для вас сейчас самое важное?');
  } finally { await f.pg.close(); }
});

test('29.09: offer → "да хочу" → one request with its fields and one confirmation (the model text)', async () => {
  const f = await fixture();
  try {
    f.reply('Юрий покажет, как это будет у вас. Договориться о встрече?\n[[OFFER: встреча с Юрием]]');
    await f.say('как это будет выглядеть у меня?');
    f.reply('Готово! Юрий свяжется с вами, чтобы договориться о встрече.\n[[REQUEST: meeting | topic=показ ассистента]]');
    const r = await f.say('да хочу');
    assert.equal(r.reply, 'Готово! Юрий свяжется с вами, чтобы договориться о встрече.');
    assert.equal(await f.requests(), 1);
    const request = (await f.pg.query<{ open_request: string }>('select open_request from simulator_sessions')).rows[0]!.open_request;
    assert.equal(request, 'meeting\ntopic: показ ассистента');
  } finally { await f.pg.close(); }
});

test('a direct request with missing required fields asks for them; collected over several messages it is created', async () => {
  const f = await fixture();
  try {
    await saveRuntimeSettings(f.db, f.tenantId, { request_required_fields: { consultation: ['city', 'when'] } });
    f.reply('Готово, записала.\n[[REQUEST: consultation | city=Ашдод]]', 'В каком городе и в какой день вам удобно?');
    const first = await f.say('хочу записаться на консультацию');
    assert.equal(await f.requests(), 0);
    assert.match(f.prompts.at(-1)!.system, /не хватает данных: when/);
    assert.equal(first.reply, 'В каком городе и в какой день вам удобно?');
    f.reply('Хорошо. Какой день удобен?');
    await f.say('в Ашдоде');
    f.reply('Записала: консультация в Ашдоде в среду. Юрий подберёт время и напишет.\n[[REQUEST: consultation | city=Ашдод; when=среда]]');
    await f.say('в среду');
    assert.equal(await f.requests(), 1, 'the direct request two turns earlier still counts');
  } finally { await f.pg.close(); }
});

test('numbers not in facts: one regeneration with the list, then "уточню у Юрия" and a question to the owner', async () => {
  const f = await fixture();
  try {
    f.reply('Интеграция с Monday — 1500 ₪.', 'Обычно это 1 200 ₪ за 3 дня.');
    const r = await f.say('сколько стоит интеграция с Monday?');
    assert.match(f.prompts.at(-1)!.system, /Этих чисел нет в Фактах и инструкции: 1500/);
    assert.equal(r.reply, 'Уточню: Юрий ответит, и я сразу вернусь к вам.');
    assert.equal(r.outcome, 'escalated');
    f.reply('Базовый ассистент — от 249 ₪ в месяц.');
    assert.equal((await f.say('а сам ассистент?')).reply, 'Базовый ассистент — от 249 ₪ в месяц.', 'numbers from the facts pass');
  } finally { await f.pg.close(); }
});

test('unsafe text is regenerated, then replaced; a missing placeholder blocks the reply', async () => {
  const f = await fixture();
  try {
    f.reply('Цена {price}', 'Ответ: undefined');
    assert.equal((await f.say('сколько стоит?')).reply, 'Подскажите, пожалуйста, что для вас сейчас самое важное?');
  } finally { await f.pg.close(); }
  const g = await fixture({ owner: ' ' });
  try {
    g.reply('Здравствуйте!');
    const r = await g.say('привет');
    assert.equal(r.reply, null);
    assert.equal(g.prompts.length, 0, 'no model call with an unfilled placeholder');
  } finally { await g.pg.close(); }
});

test('demo mode: DEMO_START … numbers from the demo text with "для примера", DEMO_END; closes by itself after demo_max_turns', async () => {
  const f = await fixture();
  try {
    f.reply('Напишите, как вам обычно пишет клиент, — отвечу так, как ответила бы ему.\n[[DEMO_START: home_cook]]');
    await f.say('покажите на примере');
    f.reply('Пельмени — 100 ₪/кг. На завтра не получится: заказ минимум за неделю, выдача во вторник или четверг.', 'Пельмени — 100 ₪/кг (цены здесь для примера). На завтра не получится: заказ минимум за неделю.');
    const r = await f.say('сколько стоят пельмени? можно на завтра?');
    assert.match(f.prompts.at(-1)!.system, /=== РЕЖИМ ПОКАЗА \(home_cook\) ===\nДЕМО-БИЗНЕС: домашний повар/);
    assert.match(f.prompts.at(-1)!.system, /цены здесь для примера|пометк|для примера/);
    assert.equal(r.reply, 'Пельмени — 100 ₪/кг (цены здесь для примера). На завтра не получится: заказ минимум за неделю.');
    f.reply('Так же ассистент будет отвечать вашим клиентам по вашим ценам. Показать, как подключиться?\n[[DEMO_END]]');
    await f.say('понятно, спасибо');
    assert.equal((await f.pg.query<{ demo_key: string | null }>('select demo_key from simulator_sessions')).rows[0]!.demo_key, null);
    // Auto close.
    await saveRuntimeSettings(f.db, f.tenantId, { demo_max_turns: 1 });
    f.reply('Напишите, как пишет клиент.\n[[DEMO_START: cosmetologist]]');
    await f.say('а для косметолога?');
    await f.say('здравствуйте, сколько ботокс?');
    await f.say('ещё вопрос');
    assert.equal((await f.pg.query<{ demo_key: string | null }>('select demo_key from simulator_sessions')).rows[0]!.demo_key, null);
  } finally { await f.pg.close(); }
});

test('HUMAN and ASK_OWNER become escalations with the model text; without an active instruction the legacy path answers', async () => {
  const f = await fixture();
  try {
    f.reply('Конечно, передаю Юрию — он напишет вам.\n[[HUMAN]]');
    const r = await f.say('хочу поговорить с человеком');
    assert.equal(r.outcome, 'escalated'); assert.equal(r.reply, 'Конечно, передаю Юрию — он напишет вам.');
  } finally { await f.pg.close(); }
  const g = await fixture({ instruction: null });
  try {
    g.reply(JSON.stringify({ reply: 'Ответ по старому пути.', unanswered: [], intent: 'sale' }));
    const r = await g.say('что вы делаете?');
    assert.ok(g.prompts.some(p => /Верни строго JSON/.test(p.system)), 'legacy prompts');
    assert.equal(r.reply, 'Ответ по старому пути.');
  } finally { await g.pg.close(); }
});

test('RLS probe under a member JWT: own business instruction readable, demo texts and writes are service-only; owner questions per tenant', async () => {
  const f = await fixture();
  try {
    const other = ((await f.db.from('tenants').insert({ name: 'B', business_name: 'B', language: 'ru', tier: 'basic', status: 'active' }).select('id').single()).data as { id: string }).id;
    await uploadInstruction(f.db, { kind: 'business', tenantId: other }, 'Чужая инструкция');
    await uploadInstruction(f.db, { kind: 'demo', demoKey: 'home_cook' }, 'Демо');
    await f.pg.query("insert into owner_questions(tenant_id,question,source) values($1,'Свой вопрос?','operator'),($2,'Чужой вопрос?','operator')", [f.tenantId, other]);
    const member = (await f.pg.query<{ id: string }>('insert into auth.users default values returning id')).rows[0]!.id;
    const viewer = (await f.pg.query<{ id: string }>('insert into auth.users default values returning id')).rows[0]!.id;
    await f.pg.query("insert into tenant_users(user_id,tenant_id,role) values($1,$2,'owner'),($3,$2,'viewer')", [member, f.tenantId, viewer]);
    const as = async <T>(user: string, sql: string, params: unknown[] = []) => {
      await f.pg.query('begin'); await f.pg.query('set local role authenticated'); await f.pg.query(`select set_config('request.jwt.claim.sub', $1, true)`, [user]);
      try { return (await f.pg.query<T>(sql, params)).rows; } finally { await f.pg.query('rollback'); }
    };
    assert.deepEqual((await as<{ content: string }>(member, 'select content from assistant_instructions')).map(r => r.content), [INSTRUCTION], 'own business only, no demo, no other tenant');
    await assert.rejects(as(member, "insert into assistant_instructions(tenant_id,kind,version,content) values($1,'business',9,'x')", [f.tenantId]), 'writes are service-only');
    assert.deepEqual((await as<{ question: string }>(member, 'select question from owner_questions')).map(r => r.question), ['Свой вопрос?']);
    await assert.rejects(as(viewer, "update owner_questions set status='dropped' where tenant_id=$1 returning id", [f.tenantId]).then(rows => { if (!rows.length) throw new Error('no rows'); }));
  } finally { await f.pg.close(); }
});

test('operator endpoints logic: versions, one active, core override; operator settings are not owner-editable', async () => {
  const f = await fixture();
  try {
    const target = { kind: 'business' as const, tenantId: f.tenantId };
    const v2 = await uploadInstruction(f.db, target, 'Версия 2 для {business_name}');
    assert.equal(v2.version, 2); assert.equal(v2.status, 'draft');
    await activateInstruction(f.db, target, 2);
    const rows = (await f.pg.query<{ version: number; status: string }>("select version,status from assistant_instructions where tenant_id=$1 order by version", [f.tenantId])).rows;
    assert.deepEqual(rows, [{ version: 1, status: 'archived' }, { version: 2, status: 'active' }]);
    await f.pg.query("insert into system_config(key,value) values('assistant_core_instruction', to_jsonb('Ядро оператора для {business_name}. {owner_name}.'::text))");
    f.reply('Здравствуйте!');
    await f.say('привет');
    assert.match(f.prompts.at(-1)!.system, /^Ядро оператора для BizGenie\. Юрий\.\n\n=== ИНСТРУКЦИЯ БИЗНЕСА ===\nВерсия 2 для BizGenie/);
  } finally { await f.pg.close(); }
});

test('Z1: a failed reply model gives the fallback and reports the operational reason for evaluations', async () => {
  const f = await fixture();
  try {
    f.reply('THROW:incomplete_max_tokens');
    const r = await f.say('сколько стоит?');
    assert.equal(r.modelFailure, 'incomplete_max_tokens');
    assert.ok(r.reply && !/incomplete|max_tokens/.test(r.reply), 'the client never sees the reason');
  } finally { await f.pg.close(); }
});

test('Z2: Hebrew message answered in Russian → one regeneration naming the language; still Russian → Hebrew template + ASK_OWNER', async () => {
  const f = await fixture({ languages: ['ru', 'he', 'en'] });
  try {
    f.reply('Здравствуйте! Чем занимается ваш бизнес?');
    await f.say('привет');
    f.reply('Ассистент запишет клиентов на стрижку.', 'האסיסטנט ירשום לקוחות לתספורת.');
    const fixed = await f.say('יש לי מספרה, איך זה יעזור לי?');
    assert.equal(fixed.reply, 'האסיסטנט ירשום לקוחות לתספורת.');
    assert.match(f.prompts.at(-2)!.system, /=== ЯЗЫК ОТВЕТА ===\nПоследнее сообщение клиента — иврит\./);
    assert.match(f.prompts.at(-1)!.system, /Ответ не на том языке: последнее сообщение клиента — иврит/);
    f.reply('Ассистент запишет клиентов.', 'Ассистент запишет клиентов.');
    const failed = await f.say('כמה זה עולה?');
    assert.match(failed.reply ?? '', /[\u0590-\u05FF]/);
    assert.equal(failed.reply, 'אבדוק עם Юрий ואחזור עם תשובה.', 'the Hebrew template; the owner name is as stored');
    assert.deepEqual(failed.labels, ['ASK_OWNER']);
  } finally { await f.pg.close(); }
});

test('Z2: DEMO_START without a valid demo key does not switch the mode on and logs the label', async () => {
  const f = await fixture();
  const warnings: unknown[][] = [], warn = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a); };
  try {
    f.reply('Напишите, как вам обычно пишет клиент.\n[[DEMO_START]]');
    const bare = await f.say('покажите на примере');
    f.reply('Напишите, как вам обычно пишет клиент.\n[[DEMO_START: car_rental]]');
    const unknown = await f.say('покажите на примере');
    f.reply('Напишите, как вам обычно пишет клиент.\n[[DEMO_START: home_cook]]');
    const known = await f.say('покажите на примере');
    assert.deepEqual(bare.labels, []); assert.deepEqual(unknown.labels, []);
    assert.deepEqual(known.labels, ['DEMO_START']);
    assert.deepEqual(warnings.filter(w => w[0] === 'instruction_demo_unknown_key').map(w => (w[1] as { label: string; key: string | null })).map(w => [w.label, w.key]), [['DEMO_START', null], ['DEMO_START', 'car_rental']]);
  } finally { console.warn = warn; await f.pg.close(); }
});

test('Z2: model failure → template with the owner name in nominative; a second one in a row is the short repeat, one escalation', async () => {
  const f = await fixture();
  try {
    f.reply('THROW:incomplete_max_tokens');
    const first = await f.say('сколько стоит?');
    assert.equal(first.reply, 'Уточню этот вопрос — Юрий ответит, и я вернусь к вам.');
    f.reply('THROW:incomplete_max_tokens');
    const second = await f.say('а установка?');
    assert.equal(second.reply, 'Я помню ваш вопрос и вернусь с ответом.');
    f.reply('Установка — от 500 ₪.');
    assert.equal((await f.say('а установка?')).reply, 'Установка — от 500 ₪.');
    f.reply('THROW:http_500');
    assert.equal((await f.say('ещё вопрос')).reply, 'Уточню этот вопрос — Юрий ответит, и я вернусь к вам.', 'a normal reply resets the repeat');
  } finally { await f.pg.close(); }
});

test('Z2: reply model limits reach the model call; the new settings are validated', async () => {
  const f = await fixture();
  try {
    const calls: unknown[] = [];
    const ai = { async generateReply(input: { generation?: unknown }) { calls.push(input.generation); return { text: 'Хорошо.' }; } };
    await simulateCustomerMessage(f.db, f.tenantId, crypto.randomUUID(), 'привет', ai as never, { evaluation: {}, embedder: null });
    assert.deepEqual(calls[0], { maxOutputTokens: 2048, retryMaxOutputTokens: 4096, thinkingLevels: { 'gemini-3.8-flash': 'low' }, timeoutMs: 20000, attemptTimeoutMs: 9000, retryDelayMs: 1500 });
    await saveRuntimeSettings(f.db, f.tenantId, { reply_max_output_tokens: 3000, reply_thinking_levels: { 'gemini-3.8-flash': 'minimal' }, reply_timeout_ms: 30000, reply_attempt_timeout_ms: 12000, reply_retry_delay_ms: 500 });
    await simulateCustomerMessage(f.db, f.tenantId, crypto.randomUUID(), 'привет', ai as never, { evaluation: {}, embedder: null });
    assert.deepEqual(calls[1], { maxOutputTokens: 3000, retryMaxOutputTokens: 4096, thinkingLevels: { 'gemini-3.8-flash': 'minimal' }, timeoutMs: 30000, attemptTimeoutMs: 12000, retryDelayMs: 500 });
    await assert.rejects(saveRuntimeSettings(f.db, f.tenantId, { reply_timeout_ms: 10 }), /Invalid setting/);
    await assert.rejects(saveRuntimeSettings(f.db, f.tenantId, { reply_thinking_levels: { 'gemini-3.8-flash': 'max' } }), /Invalid thinking levels/);
    await assert.rejects(saveRuntimeSettings(f.db, f.tenantId, { reply_max_output_tokens: 10 }), /Invalid setting/);
  } finally { await f.pg.close(); }
});

test('Z3: numbers of the answer that starts a demo are checked against the demo text; DEMO_END — against the tenant facts', async () => {
  const f = await fixture();
  try {
    f.reply('Давайте на примере домашнего повара. Напишите, как вам обычно пишет клиент.');
    await f.say('покажите на примере');
    f.reply('Пельмени — 100 ₪ за кг (цены здесь для примера). На завтра не получится.\n[[DEMO_START: home_cook]]');
    const start = await f.say('сколько стоят пельмени? можно на завтра?');
    assert.deepEqual(start.labels, ['DEMO_START']);
    assert.match(start.reply ?? '', /100 ₪/);
    f.reply('Установка — от 500 ₪, а пельмени были для примера.\n[[DEMO_END]]');
    const end = await f.say('понятно, а у вас сколько стоит?');
    assert.deepEqual(end.labels, ['DEMO_END']);
    assert.match(end.reply ?? '', /500 ₪/, 'the tenant price passes after DEMO_END');

    const g = await fixture();
    try {
      g.reply('Напишите, как вам обычно пишет клиент.');
      await g.say('покажите на примере');
      g.reply('Пельмени — 70 ₪ за кг (для примера).\n[[DEMO_START: home_cook]]', 'Пельмени — 70 ₪ за кг (для примера).\n[[DEMO_START: home_cook]]');
      const wrong = await g.say('сколько стоят пельмени?');
      assert.equal(wrong.reply, 'Уточню: Юрий ответит, и я сразу вернусь к вам.', 'a price not in the demo text is not sent');
      assert.match(g.prompts.at(-1)!.system, /Этих чисел нет в Фактах и инструкции: 70/);
      assert.doesNotMatch(g.prompts.at(-2)!.system, /=== РЕЖИМ ПОКАЗА/, 'the first variant was written before the demo was on');
      assert.match(g.prompts.at(-1)!.system, /=== РЕЖИМ ПОКАЗА \(home_cook\) ===\nДЕМО-БИЗНЕС: домашний повар/, 'the regeneration sees the demo price list');
      g.reply('Пельмени — 100 ₪ за кг.\n[[DEMO_START: home_cook]]', 'Пельмени — 100 ₪ за кг.\n[[DEMO_START: home_cook]]');
      const unmarked = await g.say('сколько стоят пельмени?');
      assert.match(unmarked.reply ?? '', /^Для примера: Пельмени — 100 ₪/, 'the first demo price is marked even in the starting answer');
    } finally { await g.pg.close(); }
  } finally { await f.pg.close(); }
});

test('Z4/Z6: reply_fallback_model without its provider key is not used (no error); setting validated', async () => {
  const f = await fixture();
  const warnings: unknown[][] = [], warn = console.warn, error = console.error;
  console.warn = (...a: unknown[]) => { warnings.push(a); }; console.error = () => {};
  try {
    await saveRuntimeSettings(f.db, f.tenantId, { reply_fallback_model: 'claude-haiku-5-5' });
    f.reply('THROW:timeout');
    // No ANTHROPIC_API_KEY in tests: the fallback is skipped, the client gets the failure template of the primary.
    const r = await f.say('сколько стоит?');
    assert.equal(r.reply, 'Уточню этот вопрос — Юрий ответит, и я вернусь к вам.');
    assert.equal(r.modelFailure, 'timeout');
    assert.equal(warnings.filter(w => w[0] === 'model_fallback').length, 0, 'no key — no fallback attempt');
    await assert.rejects(saveRuntimeSettings(f.db, f.tenantId, { reply_fallback_model: 'claude haiku; drop' }), /Invalid fallback model/);
  } finally { console.warn = warn; console.error = error; await f.pg.close(); }
});

test('Z6: a tenant without its own instruction answers by the template of its sector; unknown → general; own wins; setting overrides', async () => {
  const f = await fixture({ instruction: null });
  try {
    const publish = async (templateKey: 'service_booking' | 'general' | 'order', text: string) => {
      await uploadInstruction(f.db, { kind: 'template', templateKey }, text);
      const v = (await f.pg.query<{ version: number }>("select max(version) as version from assistant_instructions where template_key=$1", [templateKey])).rows[0]!.version;
      await activateInstruction(f.db, { kind: 'template', templateKey }, Number(v));
    };
    const sector = (value: string) => f.pg.query('update tenants set business_sector=$2 where id=$1', [f.tenantId, value]);
    const instructionOf = () => /=== ИНСТРУКЦИЯ БИЗНЕСА ===\n(.*)/.exec(f.prompts.at(-1)!.system)?.[1];

    // Nothing published: the legacy path answers (no model call through the instruction prompt).
    f.reply('Хорошо.');
    await f.say('привет');
    assert.equal(f.prompts.filter(p => p.system.includes('=== ИНСТРУКЦИЯ БИЗНЕСА ===')).length, 0);
    assert.equal((await readRuntimeSettings(f.db, f.tenantId)).instruction_answers, false);

    await publish('service_booking', 'ШАБЛОН запись для {business_name}, владелец {owner_name}.');
    await publish('general', 'ШАБЛОН общий для {business_name}.');
    await sector('мастер маникюра');
    f.reply('Здравствуйте!');
    await f.say('сколько стоит маникюр?');
    assert.equal(instructionOf(), 'ШАБЛОН запись для BizGenie, владелец Юрий.');
    const settings = await readRuntimeSettings(f.db, f.tenantId);
    assert.equal(settings.instruction_answers, true);
    assert.deepEqual(settings.simulator_suggestions.ru, ['Сколько стоит и сколько длится процедура?', 'Можно записаться на эту неделю?', 'Где вы принимаете?']);

    await sector('צלמת חתונות');     // project — not published → general
    await f.say('שלום');
    assert.equal(instructionOf(), 'ШАБЛОН общий для BizGenie.');
    await sector('что-то совсем другое'); // no match → general
    await f.say('привет');
    assert.equal(instructionOf(), 'ШАБЛОН общий для BizGenie.');

    await saveRuntimeSettings(f.db, f.tenantId, { instruction_template: 'service_booking' }); // operator setting wins over the sector
    await f.say('привет');
    assert.equal(instructionOf(), 'ШАБЛОН запись для BizGenie, владелец Юрий.');

    await uploadInstruction(f.db, { kind: 'business', tenantId: f.tenantId }, 'СВОЯ инструкция {business_name}.');
    await activateInstruction(f.db, { kind: 'business', tenantId: f.tenantId }, 1);
    await f.say('привет');
    assert.equal(instructionOf(), 'СВОЯ инструкция BizGenie.', 'its own instruction wins over any template');

    await assert.rejects(saveRuntimeSettings(f.db, f.tenantId, { instruction_template: 'beauty' }), /Invalid instruction template/);
    await saveRuntimeSettings(f.db, f.tenantId, { instruction_template: '' });
  } finally { await f.pg.close(); }
});

test('Z6: sector → template table (cabinet suggestions ru/he/en and keywords), defaults of the one scheme', async () => {
  const { templateForSector } = await import('../config/instruction-templates.js');
  for (const [sector, key] of [
    ['косметолог', 'service_booking'], ['Парикмахер', 'service_booking'], ['мастер маникюра', 'service_booking'], ['репетитор', 'service_booking'],
    ['ресторан', 'order'], ['кафе', 'order'], ['магазин', 'order'], ['риелтор', 'general'],
    ['קוסמטיקאית', 'service_booking'], ['מעצב שיער', 'service_booking'], ['טכנאית ציפורניים', 'service_booking'], ['מסעדה', 'order'], ['בית קפה', 'order'], ['חנות', 'order'], ['מתווך נדל״ן', 'general'], ['מורה פרטי', 'service_booking'],
    ['cosmetologist', 'service_booking'], ['Nail technician', 'service_booking'], ['café', 'order'], ['real estate agent', 'general'], ['tutor', 'service_booking'],
    ['IT outsourcing', 'b2b'], ['автоматизация бизнеса', 'b2b'], ['домашний повар', 'order'], ['что-то другое', 'general'], ['', 'general'],
  ] as const) assert.equal(templateForSector(sector), key, sector);
  const f = await fixture({ instruction: null });
  try {
    assert.deepEqual([BEHAVIOR_DEFAULTS.reply_engine, BEHAVIOR_DEFAULTS.reply_model, BEHAVIOR_DEFAULTS.reply_fallback_model, BEHAVIOR_DEFAULTS.instruction_template], ['instruction', 'gemini-3.8-flash', 'gpt-6.1-sol', '']);
    const s = await readRuntimeSettings(f.db, f.tenantId);
    assert.ok(s.request_required_fields.booking && s.request_required_fields.order && s.request_required_fields.estimate && s.request_required_fields.request);
    assert.deepEqual([s.request_required_fields.booking, s.request_required_fields.reschedule, s.request_required_fields.cancel, s.request_required_fields.order, s.request_required_fields.estimate, s.request_required_fields.request],
      [['service', 'when'], ['when'], [], ['items', 'date'], ['task'], ['what']]);
  } finally { await f.pg.close(); }
});

test('eval cost rules: a 402 of the reply model stops the eval scenario (no further paid calls)', async () => {
  const { runScenario, PaymentStop } = await import('../evals/instruction-eval.js');
  const f = await fixture();
  const error = console.error, warn = console.warn; console.error = () => {}; console.warn = () => {};
  try {
    let judged = 0;
    const model = { async generateReply(): Promise<never> { throw new AIProviderError('Gemini reply unavailable', undefined, { reason: 'http_402' }); } };
    const judgeAI = { async generateReply() { judged++; return { text: '{"results":[true]}' }; } };
    await assert.rejects(runScenario(f.db, f.tenantId, { id: 'x', turns: ['привет', 'ещё'], checks: ['a'] }, 1, model, judgeAI), (e: Error) => e instanceof PaymentStop && /reply \(x\)/.test(e.message));
    assert.equal(judged, 0, 'the judge is not called after a payment failure');
  } finally { console.error = error; console.warn = warn; await f.pg.close(); }
});

test('Z8: the core names the assistant by assistant_profiles.assistant_name; empty name → «Лея»', async () => {
  for (const [name, expected] of [['Мира', 'Мира'], ['', 'Лея'], ['  ', 'Лея']] as const) {
    const f = await fixture();
    try {
      await f.pg.query('update assistant_profiles set assistant_name=$2 where tenant_id=$1', [f.tenantId, name]);
      f.reply('Здравствуйте!');
      await f.say('сколько стоит?');
      const p = f.prompts.at(-1)!;
      assert.match(p.system, new RegExp(`^Ты — ${expected}, ассистент бизнеса «BizGenie»`));
      assert.match(p.system, new RegExp(`«Я ${expected}, ИИ-ассистент BizGenie»`));
      assert.doesNotMatch(p.system, /\{assistant_name\}/);
    } finally { await f.pg.close(); }
  }
});

test('Z11: the owner rules are a block after the instruction and before the facts; the core says they win over the instruction', async () => {
  const f = await fixture();
  try {
    await f.pg.query("insert into owner_rules(tenant_id,number,text,source) values($1,1,'Город не спрашивай.','whatsapp'),($1,2,'Старое правило.','cabinet')", [f.tenantId]);
    await f.pg.query('update owner_rules set active=false where number=2 and tenant_id=$1', [f.tenantId]);
    f.reply('Здравствуйте! Я Лея.\nЧем могу помочь?');
    await f.say('Привет');
    const system = f.prompts.at(-1)!.system;
    const instruction = system.indexOf('=== ИНСТРУКЦИЯ БИЗНЕСА ==='), rules = system.indexOf('=== ПРАВИЛА ЭТОГО БИЗНЕСА ==='), facts = system.indexOf('=== ФАКТЫ ===');
    assert.ok(instruction >= 0 && rules > instruction && facts > rules, 'instruction → rules → facts');
    assert.match(system, /=== ПРАВИЛА ЭТОГО БИЗНЕСА ===\n1\. Город не спрашивай\./);
    assert.doesNotMatch(system, /Старое правило/, 'only active rules');
    assert.match(system, /Правила бизнеса важнее инструкции; правила ядра важнее правил бизнеса\./);
  } finally { await f.pg.close(); }
});

test('Z11 review (eval M11): «записала» / «вы записаны» is never sent — the reply is rewritten; still so → the owner will confirm', async () => {
  const { CLAIMED_BOOKED_PATTERN } = await import('../config/consent.js');
  for (const t of ['Отлично, среду после обеда записала.', 'Вы записаны на четверг.', 'רשמתי אותך ליום רביעי', "Great, you're booked for Wednesday", 'I have booked you for 3pm'])
    assert.match(t, CLAIMED_BOOKED_PATTERN, t);
  for (const t of ['Записать вас на среду после обеда?', 'Хочу записаться', 'Ольга подтвердит время.', 'Can I book you for Wednesday?'])
    assert.doesNotMatch(t, CLAIMED_BOOKED_PATTERN, t);
  const f = await fixture();
  try {
    f.reply('Отлично, среду после обеда записала. В каком филиале удобнее?', 'Передам Юрию запрос на среду после обеда — он подтвердит время. Хорошо?\n[[OFFER: запись на среду]]');
    const fixed = await f.say('хочу записаться в среду после обеда');
    assert.equal(f.prompts.length, 2, 'regenerated once');
    assert.match(f.prompts[1]!.system, /Не пиши, что записала клиента или подтвердила время/);
    assert.match(String(fixed.reply), /подтвердит время/); assert.doesNotMatch(String(fixed.reply), /записала/);
    f.reply('Записала вас на среду.', 'Всё, вы записаны на среду!');
    const fallback = await f.say('а на четверг?');
    assert.equal(fallback.reply, 'Уточню: Юрий ответит, и я сразу вернусь к вам.', 'twice → the owner will answer');
  } finally { await f.pg.close(); }
});
