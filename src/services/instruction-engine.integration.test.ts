import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, pgliteDatabaseClient } from './test-support/pglite-harness.js';
import { simulateCustomerMessage } from './simulator.service.js';
import { saveRuntimeSettings } from './runtime-settings.service.js';
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
  await saveRuntimeSettings(db, tenantId, { reply_engine: options.engine ?? 'instruction' });
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
    assert.deepEqual(calls[0], { maxOutputTokens: 2048, retryMaxOutputTokens: 4096, thinkingLevels: { 'gemini-3.8-flash': 'low' } });
    await saveRuntimeSettings(f.db, f.tenantId, { reply_max_output_tokens: 3000, reply_thinking_levels: { 'gemini-3.8-flash': 'minimal' } });
    await simulateCustomerMessage(f.db, f.tenantId, crypto.randomUUID(), 'привет', ai as never, { evaluation: {}, embedder: null });
    assert.deepEqual(calls[1], { maxOutputTokens: 3000, retryMaxOutputTokens: 4096, thinkingLevels: { 'gemini-3.8-flash': 'minimal' } });
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
      g.reply('Пельмени — 100 ₪ за кг.\n[[DEMO_START: home_cook]]', 'Пельмени — 100 ₪ за кг.\n[[DEMO_START: home_cook]]');
      const unmarked = await g.say('сколько стоят пельмени?');
      assert.match(unmarked.reply ?? '', /^Для примера: Пельмени — 100 ₪/, 'the first demo price is marked even in the starting answer');
    } finally { await g.pg.close(); }
  } finally { await f.pg.close(); }
});
