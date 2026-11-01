import assert from 'node:assert/strict';
import test from 'node:test';
import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { createTestDatabase, pgliteDatabaseClient } from './test-support/pglite-harness.js';
import { OWNER_GROUPS, seedOwnerGroups } from './test-support/owner-groups.js';
import { handleOwnerMessage } from './owner-workflow.service.js';
import { invalidateOwnerSettings, loadOwnerSettings } from './owner-settings.service.js';
import { handleOwnerGroupMessage } from './owner-group-inbound.service.js';
import { createHash } from 'node:crypto';
import { ensureAllOwnerChannels, sendHintOnce, sendPendingHints } from './owner-channels.service.js';
import { understandOwnerMessage } from './owner-rules.service.js';
import { runDailyReports } from './daily-report.service.js';
import { settleAllOutboundQueues, stopOutboundQueue } from '../workers/outbound-queue.js';

process.env.GEMINI_API_KEY = '';
process.env.SUPABASE_URL = 'https://database.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';

const owner = '972500000002@c.us', group = OWNER_GROUPS.needsAnswer, supportGroup = '120363000000099@g.us', operator = '972500000077';
const REPORTS = 'Сюда каждое утро приходит отчёт за вчера: кто писал, кто оставил заявку, кто ушёл и почему. Здесь тоже можно спросить ассистента — напишите „помощь“.';
const HELP = 'Сюда приходят вопросы клиентов и заявки — отвечайте реплеем.\nМожно писать обычными словами:\n• правило: „не спрашивай город“\n• настройка: „не пиши мне после 22:00“\n• „стоп“ — остановить все ответы, „включи“ — вернуть\n• проблема или пожелание — передам в BizGenie\n• „что ты умеешь?“ — покажу всё';

/** Z15: the owner writes in «Нужен ответ»; the task model is a stub answering the next queued JSON. A platform tenant (BizGenie) has the support group. */
async function fixture() {
  const pg = await createTestDatabase();
  const db = pgliteDatabaseClient(pg);
  const newTenant = async (name: string, business: string) => ((await db.from('tenants').insert({ name, business_name: business, language: 'ru', tier: 'basic', status: 'active' }).select('id').single()).data as { id: string }).id;
  const tenantId = await newTenant('Ира', 'Ноготки'), platformId = await newTenant('Юрий', 'BizGenie');
  await pg.query("insert into notification_settings(tenant_id,owner_phone,owner_chat_id,mode,time_zone,auto_replies_paused,behavior) values($1,'972500000002',$2,'mute_all','Asia/Jerusalem',false,'{\"owner_language\":\"ru\"}')", [tenantId, owner]);
  await pg.query("insert into whatsapp_instances(tenant_id,session_name,waha_url) values($1,'session','http://waha.test'),($2,'platform','http://waha.test')", [tenantId, platformId]);
  await pg.query("insert into system_config(key,value) values('platform_report_tenant',to_jsonb($1::text)),('platform_report_number',to_jsonb($2::text)),('cabinet_url','\"https://cabinet.test\"')", [platformId, operator]);
  await pg.query("insert into plans(code,display_name,messages_per_month,voice_minutes_per_month,warning_percent,unlimited) values('basic','Базовый',500,60,80,false) on conflict(code) do nothing");
  await pg.query("insert into tenant_usage_limits(tenant_id,plan,messages_per_month,voice_minutes_per_month,warning_percent,messages_overridden,voice_overridden,warning_overridden) values($1,'basic',500,60,80,false,false,false)", [tenantId]);
  await seedOwnerGroups(pg, tenantId, owner);
  const sent: { session: string; chatId: string; text: string; id: string }[] = [], groups: { session: string; name: string; participants: string[] }[] = [], descriptions: string[] = [];
  const provider: WhatsAppProvider = {
    async getSessionStatus() { return { status: 'WORKING', me: { id: '972500000009@c.us' } }; },
    async sendMessage(input) { const id = `true_${input.chatId}_M${sent.length}_972500000009@c.us`; sent.push({ ...input, id }); return { id }; },
    async createGroup(session, input) { groups.push({ session, ...input }); return supportGroup; },
    async setGroupDescription(_s, _c, text) { descriptions.push(text); },
  } as WhatsAppProvider;
  const answers: string[] = [], prompts: string[] = [];
  const ruleAI = { async generateReply(input: { systemPrompt: string; userMessage: string }) { prompts.push(input.userMessage); return { text: answers.shift() ?? '{"kind":"other","answer":"Хорошо."}' }; } };
  const say = async (text: string, quoted: string | null = null, from = owner) => {
    invalidateOwnerSettings(db, tenantId);
    const settings = await loadOwnerSettings(db, tenantId);
    const handled = await handleOwnerMessage(db, provider, tenantId, 'session', from, text, quoted, settings, null, `in-${Math.random()}`, group, { ruleAI: ruleAI as never });
    await settleAllOutboundQueues();
    return { handled, last: sent.at(-1)! };
  };
  const settings = async () => { invalidateOwnerSettings(db, tenantId); return loadOwnerSettings(db, tenantId); };
  return { pg, db, tenantId, platformId, sent, groups, descriptions, provider, say, settings, prompts,
    model: (...a: object[]) => { answers.push(...a.map(x => JSON.stringify(x))); }, async close() { await stopOutboundQueue(db); await pg.close(); } };
}

test('Z15: a setting from the list → «Было → станет. Сохранить?»; applied only after «Да»; «Нет» changes nothing', async () => {
  const f = await fixture();
  try {
    f.model({ kind: 'setting', setting: { key: 'quiet_hours', value: { start: '22:00', end: '08:00' } } });
    const asked = await f.say('не пиши мне после 22:00');
    assert.equal(asked.last.chatId, group);
    assert.equal(asked.last.text, 'Когда не писать вам: было выключено → станет 22:00–08:00. Сохранить? Да / Нет');
    assert.equal((await f.settings()).quiet_hours_start, null, 'nothing before «Да»');
    assert.equal((await f.say('нет')).last.text, 'Хорошо, не меняю.');
    assert.equal((await f.settings()).quiet_hours_start, null);
    f.model({ kind: 'setting', setting: { key: 'quiet_hours', value: { start: '22:00', end: '08:00' } } });
    const again = await f.say('не пиши мне после 22:00');
    assert.equal((await f.say('Да', again.last.id)).last.text, 'Сохранила.');
    const s = await f.settings();
    assert.deepEqual([s.quiet_hours_start?.slice(0, 5), s.quiet_hours_end?.slice(0, 5)], ['22:00', '08:00']);
    // The morning report and «Дописывать мои короткие ответы»: the same path.
    f.model({ kind: 'setting', setting: { key: 'polish_owner_answer', value: false } });
    assert.equal((await f.say('не дописывай мои ответы')).last.text, 'Дописывать мои короткие ответы: было включено → станет выключено. Сохранить? Да / Нет');
    await f.say('да');
    assert.equal((await f.settings()).behavior?.polish_owner_answer, false);
  } finally { await f.close(); }
});

test('Z15: only settings from the list are applied; cabinet-only ones get a link; the model value is checked by the code', async () => {
  const f = await fixture();
  try {
    f.model({ kind: 'setting', setting: { key: 'reply_model', value: 'gpt-x' } });
    assert.equal((await f.say('поменяй модель')).last.text, 'Не поняла, на что поменять. Напишите, например: „не пиши мне после 22:00“.');
    f.model({ kind: 'setting', setting: { key: 'auto_resume_hours', value: 500 } });
    assert.equal((await f.say('возвращайся через 500 часов')).last.text, 'Не поняла, на что поменять. Напишите, например: „не пиши мне после 22:00“.');
    assert.equal((await f.say('да')).last.text, 'Хорошо.', '«Да» after a refused setting applies nothing');
    assert.equal((await f.settings()).behavior?.reply_model, undefined);
    assert.equal((await f.settings()).behavior?.auto_resume_hours, undefined);
    f.model({ kind: 'setting', setting: { key: 'time_zone', value: null } });
    assert.equal((await f.say('поменяй часовой пояс')).last.text, 'Это меняется в кабинете: https://cabinet.test/admin/settings?section=quiet');
    assert.equal((await f.pg.query<{ n: number }>("select count(*)::int n from owner_rule_proposals where action='setting'")).rows[0]!.n, 0);
  } finally { await f.close(); }
});

test('Z15: «стоп» / «включи» at once without the model; «что ты умеешь?» shows the hints', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.say('Стоп')).last.text, 'Остановила все ответы клиентам. Чтобы включить — напишите „включи“');
    assert.equal((await f.settings()).auto_replies_paused, true);
    assert.equal((await f.say('עצור')).last.text, 'Остановила все ответы клиентам. Чтобы включить — напишите „включи“');
    assert.equal((await f.say('ВКЛЮЧИ')).last.text, 'Включила ответы клиентам.');
    assert.equal((await f.settings()).auto_replies_paused, false);
    assert.equal((await f.say('что ты умеешь?')).last.text, HELP);
    assert.equal((await f.say('help')).last.text, HELP);
    assert.equal(f.prompts.length, 0, 'no model call');
  } finally { await f.close(); }
});

test('Z15: another participant of the owner group changes nothing', async () => {
  const f = await fixture();
  try {
    f.model({ kind: 'setting', setting: { key: 'auto_replies_paused', value: true } });
    const before = f.sent.length;
    assert.equal((await f.say('стоп', null, '972500000055@c.us')).handled, false);
    assert.equal((await f.say('не пиши мне после 22:00', null, '972500000055@c.us')).handled, false);
    assert.equal(f.sent.length, before);
    assert.equal((await f.settings()).auto_replies_paused, false);
    assert.equal(f.prompts.length, 0);
  } finally { await f.close(); }
});

test('Z15: an ambiguous message → one question with 1/2/3; the chosen option still waits for «Да»', async () => {
  const f = await fixture();
  try {
    f.model({ kind: 'ambiguous', answer: 'Что сделать по субботам?', options: [
      { label: 'Не отвечать клиентам в субботу', kind: 'add_rule', rule: 'В субботу клиентам не отвечай.' },
      { label: 'Не писать вам в субботу', kind: 'setting', setting: { key: 'day_off', value: { start_date: '2026-11-07', end_date: '2026-11-07', name: 'Суббота' } } },
      { label: 'Остановить все ответы', kind: 'setting', setting: { key: 'auto_replies_paused', value: true } }] });
    assert.equal((await f.say('не отвечай по субботам')).last.text, 'Что сделать по субботам?\n1. Не отвечать клиентам в субботу\n2. Не писать вам в субботу\n3. Остановить все ответы\nОтветьте цифрой.');
    assert.equal((await f.say('3')).last.text, 'Ответы клиентам: было включены → станет остановлены. Сохранить? Да / Нет');
    assert.equal((await f.settings()).auto_replies_paused, false, 'the digit is not «Да»');
    await f.say('да');
    assert.equal((await f.settings()).auto_replies_paused, true);
    f.model({ kind: 'ambiguous', answer: 'Что сделать?', options: [{ label: 'Правило', kind: 'add_rule', rule: 'В субботу клиентам не отвечай.' }, { label: 'Выходной', kind: 'setting', setting: { key: 'day_off', value: { start_date: '2026-11-07', name: 'Суббота' } } }] });
    await f.say('суббота');
    assert.equal((await f.say('1')).last.text, 'Поняла так: «В субботу клиентам не отвечай.». Сохранить? Да / Нет');
  } finally { await f.close(); }
});

test('Z15: a request to BizGenie → «Передать?» → support_requests + the operator group; the operator\'s quote → the owner verbatim; the owner\'s quote → the operator again', async () => {
  const f = await fixture();
  try {
    f.model({ kind: 'support', support: 'Ассистент не ответил клиентке вчера вечером' });
    assert.equal((await f.say('у меня проблема, ассистент не ответил клиентке вчера вечером')).last.text, 'Передать в BizGenie: «у меня проблема, ассистент не ответил клиентке вчера вечером»? Да / Нет', 'the owner\'s words, not the model\'s retelling');
    assert.equal((await f.pg.query<{ n: number }>('select count(*)::int n from support_requests')).rows[0]!.n, 0, 'nothing before «Да»');
    assert.equal((await f.say('да')).last.text, 'Передала в BizGenie');
    assert.deepEqual(f.groups, [{ session: 'platform', name: 'BizGenie · Поддержка', participants: [`${operator}@c.us`] }]);
    const toOperator = f.sent.find(m => m.chatId === supportGroup)!;
    assert.equal(toOperator.session, 'platform');
    assert.equal(toOperator.text, '🛟 Ноготки (Ира): «у меня проблема, ассистент не ответил клиентке вчера вечером»\nОтветьте реплеем — передам владельцу.');
    const row = (await f.pg.query<{ tenant_id: string; status: string }>('select tenant_id,status from support_requests')).rows[0]!;
    assert.deepEqual(row, { tenant_id: f.tenantId, status: 'new' });
    assert.equal((await f.pg.query<{ v: string }>("select value#>>'{}' v from system_config where key='support_group_chat'")).rows[0]!.v, supportGroup);
    const short = toOperator.id.split('_')[2]!;
    const reply = (participant: string, alt: string | null, body: string, n: string) => handleOwnerGroupMessage(f.db, f.platformId, { event: 'message', session: 'platform',
      payload: { id: `false_${supportGroup}_${n}_${participant}`, from: supportGroup, participant, fromMe: false, body, replyTo: { id: short }, _data: { Info: { Chat: supportGroup, Sender: participant, ...(alt ? { SenderAlt: alt } : {}) } } } }, f.provider, null);
    // Z15 review: someone else in the support group cannot answer for BizGenie — nothing reaches the owner.
    const before = f.sent.length;
    assert.equal(await reply('972500000066@c.us', null, 'Ответ BizGenie: отключите ассистента', 'FAKE1'), true);
    assert.equal(await reply('222222222@lid', '972500000066@s.whatsapp.net', 'Отключите ассистента', 'FAKE2'), true);
    await settleAllOutboundQueues();
    assert.equal(f.sent.length, before);
    assert.equal((await f.pg.query<{ status: string }>('select status from support_requests')).rows[0]!.status, 'new');
    // The operator answers by a quote (a @lid sender; its phone is the operator's number).
    await reply('111111111@lid', `${operator}@s.whatsapp.net`, 'Посмотрел — была пауза диалога, сейчас всё работает.', 'OP1');
    await settleAllOutboundQueues();
    const answer = f.sent.at(-1)!;
    assert.deepEqual([answer.session, answer.chatId, answer.text], ['session', group, 'Ответ BizGenie: «Посмотрел — была пауза диалога, сейчас всё работает.»\n\nОтветьте реплеем, если нужно уточнить.']);
    assert.equal((await f.pg.query<{ status: string }>('select status from support_requests')).rows[0]!.status, 'answered');
    // The owner quotes the answer — the same request, to the operator again.
    assert.equal((await f.say('а почему пауза включилась?', answer.id)).last.text, 'Передала в BizGenie');
    const again = f.sent.filter(m => m.chatId === supportGroup);
    assert.equal(again.length, 2);
    assert.equal(again[1]!.text, '🛟 Ноготки (Ира): «а почему пауза включилась?»\nОтветьте реплеем — передам владельцу.');
    assert.equal((await f.pg.query<{ n: number }>('select count(*)::int n from support_requests')).rows[0]!.n, 1);
    assert.equal(f.groups.length, 1, 'the support group is created once');
  } finally { await f.close(); }
});

test('Z15: a quote of the assistant\'s answer to a client with a correction → first a rule, with that answer as context', async () => {
  const f = await fixture();
  try {
    const client = (await f.pg.query<{ id: string }>("insert into clients(tenant_id,phone,whatsapp_jid) values($1,'972500000033','972500000033@c.us') returning id", [f.tenantId])).rows[0]!.id;
    const conversation = (await f.pg.query<{ id: string }>('insert into conversations(tenant_id,client_id) values($1,$2) returning id', [f.tenantId, client])).rows[0]!.id;
    await f.pg.query("insert into messages(tenant_id,conversation_id,from_me,body,waha_msg_id) values($1,$2,true,'Доставим завтра до обеда.','true_972500000033@c.us_ANS1')", [f.tenantId, conversation]);
    f.model({ kind: 'add_rule', rule: 'Доставку не предлагай — её нет.' });
    assert.equal((await f.say('неправильно, у нас нет доставки', 'ANS1')).last.text, 'Поняла так: «Доставку не предлагай — её нет.». Сохранить? Да / Нет');
    assert.match(f.prompts.at(-1)!, /Ответ ассистента клиенту: Доставим завтра до обеда\./);
    // A request to BizGenie by such a quote keeps the answer and its dialog.
    f.model({ kind: 'support', support: 'Передай Юрию: ассистент выдумал доставку' });
    assert.equal((await f.say('передай Юрию, что ассистент выдумал доставку', 'ANS1')).last.text, 'Передать в BizGenie: «передай Юрию, что ассистент выдумал доставку»? Да / Нет');
    await f.say('да');
    assert.deepEqual((await f.pg.query('select quoted_text,conversation_id from support_requests')).rows[0], { quoted_text: 'Доставим завтра до обеда.', conversation_id: conversation });
    assert.match(f.sent.find(m => m.chatId === supportGroup)!.text, /\nК ответу ассистента: «Доставим завтра до обеда\.»\n/);
  } finally { await f.close(); }
});

test('Z15/Z16: the welcome goes once to each owner group created before — description and first message', async () => {
  const f = await fixture();
  try {
    await f.pg.query('update owner_channels set hint_sent_at=null');
    await sendPendingHints(f.db, () => f.provider);
    await settleAllOutboundQueues();
    await sendPendingHints(f.db, () => f.provider);
    await settleAllOutboundQueues();
    assert.deepEqual(f.sent.map(m => [m.chatId, m.text]).sort(), [[group, HELP], [OWNER_GROUPS.reports, REPORTS]].sort(), 'once to each group');
    assert.deepEqual(f.descriptions.sort(), [HELP, REPORTS].sort());
  } finally { await f.close(); }
});

test('Z16 review: a failed welcome (description or queue) is sent again by the hourly job, once', async () => {
  const f = await fixture();
  try {
    await f.pg.query('update owner_channels set hint_sent_at=null');
    const setDescription = f.provider.setGroupDescription!;
    f.provider.setGroupDescription = async () => { throw new Error('waha down'); };
    await sendPendingHints(f.db, () => f.provider);
    await settleAllOutboundQueues();
    assert.equal(f.sent.length, 0);
    // The queue fails for «Нужен ответ».
    f.provider.setGroupDescription = setDescription;
    const settings = await loadOwnerSettings(f.db, f.tenantId);
    await assert.rejects(sendHintOnce(f.db, f.provider, f.tenantId, 'session', settings, 'needs_answer', group, { send: async () => { throw new Error('queue'); } }));
    await sendPendingHints(f.db, () => f.provider);
    await settleAllOutboundQueues();
    await sendPendingHints(f.db, () => f.provider);
    await settleAllOutboundQueues();
    assert.deepEqual(f.sent.map(m => [m.chatId, m.text]).sort(), [[group, HELP], [OWNER_GROUPS.reports, REPORTS]].sort());
    // The description is set again on the retry (idempotent): both groups have it.
    assert.deepEqual([...new Set(f.descriptions)].sort(), [HELP, REPORTS].sort());
  } finally { await f.close(); }
});

test('Z16 review: the rule model forbids showing another business except for demo_tenant', async () => {
  const f = await fixture();
  try {
    const prompts: string[] = [];
    const taskAI = { async generateReply(input: { systemPrompt: string }) { prompts.push(input.systemPrompt); return { text: '{"kind":"other","answer":"Хорошо."}' }; } } as never;
    const settings = await loadOwnerSettings(f.db, f.tenantId);
    await understandOwnerMessage(f.db, f.tenantId, settings, 'показывай пример за другой бизнес', { taskAI });
    await f.pg.query("insert into system_config(key,value,updated_at) values ('demo_tenant',$1,now()) on conflict (key) do update set value=excluded.value", [JSON.stringify(f.tenantId)]);
    await understandOwnerMessage(f.db, f.tenantId, settings, 'показывай пример за другой бизнес', { taskAI });
    assert.equal(prompts.length, 2);
    assert.match(prompts[0]!, /отвечать за другой бизнес/);
    assert.doesNotMatch(prompts[1]!, /другой бизнес/);
  } finally { await f.close(); }
});

/** Z16: an owner without groups; createGroup gives a new group id each time. */
function withGroupCreation(f: Awaited<ReturnType<typeof fixture>>) {
  let n = 0;
  f.provider.createGroup = async (session, input) => { f.groups.push({ session, ...input }); return `12036300000010${n++}@g.us`; };
}

test('Z16: both groups as soon as the owner\'s number is confirmed — description and first message in each, once', async () => {
  const f = await fixture();
  try {
    withGroupCreation(f);
    await f.pg.query('delete from owner_channels where tenant_id=$1', [f.tenantId]);
    await f.pg.query("update notification_settings set owner_chat_id=null,owner_pairing_hash=$2,owner_pairing_expires_at=now()+interval '10 minutes' where tenant_id=$1", [f.tenantId, createHash('sha256').update('123456').digest('hex')]);
    await f.say('123456');
    assert.deepEqual(f.groups.map(g => [g.name, g.participants]), [['Leya · Нужен ответ', [owner]], ['Leya · Отчёты', [owner]]], 'both at once, not at the first message');
    const welcome = f.sent.filter(m => m.chatId.startsWith('1203630000001'));
    assert.deepEqual(welcome.map(m => [m.chatId, m.text]), [['120363000000100@g.us', HELP], ['120363000000101@g.us', REPORTS]]);
    assert.ok(f.descriptions.includes(HELP) && f.descriptions.includes(REPORTS));
    // The hourly job: nothing more — no group twice, no welcome twice.
    const before = [f.groups.length, f.sent.length];
    await ensureAllOwnerChannels(f.db, () => f.provider);
    await sendPendingHints(f.db, () => f.provider);
    await settleAllOutboundQueues();
    assert.deepEqual([f.groups.length, f.sent.length], before);
  } finally { await f.close(); }
});

test('Z16: an owner connected before, without «Отчёты» — the hourly job creates it once, with its welcome', async () => {
  const f = await fixture();
  try {
    withGroupCreation(f);
    await f.pg.query("delete from owner_channels where tenant_id=$1 and topic='reports'", [f.tenantId]);
    await ensureAllOwnerChannels(f.db, () => f.provider);
    await settleAllOutboundQueues();
    await ensureAllOwnerChannels(f.db, () => f.provider);
    await settleAllOutboundQueues();
    assert.deepEqual(f.groups.map(g => g.name), ['Leya · Отчёты']);
    assert.deepEqual(f.sent.map(m => [m.chatId, m.text]), [['120363000000100@g.us', REPORTS]]);
  } finally { await f.close(); }
});

test('Z16: «помощь» works in «Отчёты» too — the answer goes there; the morning report ends with where to ask for help', async () => {
  const f = await fixture();
  try {
    await handleOwnerGroupMessage(f.db, f.tenantId, { event: 'message', session: 'session', payload: { id: `false_${OWNER_GROUPS.reports}_H1_${owner}`, from: OWNER_GROUPS.reports, participant: owner, fromMe: false, body: 'помощь', _data: { Info: { Chat: OWNER_GROUPS.reports, Sender: owner } } } }, f.provider, null);
    await settleAllOutboundQueues();
    assert.deepEqual([f.sent.at(-1)!.chatId, f.sent.at(-1)!.text], [OWNER_GROUPS.reports, HELP]);
    for (const word of ['עזרה', 'help', 'что ты умеешь?']) {
      await f.say(word);
      assert.equal(f.sent.at(-1)!.text, HELP, word);
    }
    // The report (here: replies stopped, no dialogs) — the last line is the help line.
    await f.pg.query("update notification_settings set auto_replies_paused=true,behavior=behavior||'{\"daily_report_enabled\":true,\"daily_report_time\":\"00:00\"}' where tenant_id=$1", [f.tenantId]);
    invalidateOwnerSettings(f.db, f.tenantId);
    await runDailyReports(f.db, () => f.provider, new Date('2026-11-02T09:00:00Z'));
    await settleAllOutboundQueues();
    const report = f.sent.filter(m => m.chatId === OWNER_GROUPS.reports).at(-1)!;
    assert.match(report.text, /\n\nНужна помощь\? Напишите „помощь“ в группе „Leya · Нужен ответ“\.$/);
  } finally { await f.close(); }
});

test('Z15 review: a failed save keeps the setting waiting — the next «Да» saves it; a request not delivered to BizGenie waits too', async () => {
  const f = await fixture();
  const error = console.error; console.error = () => {};
  try {
    f.model({ kind: 'setting', setting: { key: 'day_off', value: { start_date: '2026-11-10', end_date: '2026-11-11', name: 'Отпуск' } } });
    await f.say('10 и 11 ноября я в отпуске');
    await f.pg.query('alter table schedule_exceptions add constraint z15_fail check (false) not valid');
    assert.equal((await f.say('да')).last.text, 'Не поняла, на что поменять. Напишите, например: „не пиши мне после 22:00“.');
    assert.equal((await f.pg.query<{ status: string }>("select status from owner_rule_proposals where action='setting'")).rows[0]!.status, 'pending');
    await f.pg.query('alter table schedule_exceptions drop constraint z15_fail');
    assert.equal((await f.say('да')).last.text, 'Сохранила.');
    assert.equal((await f.pg.query<{ n: number }>('select count(*)::int n from schedule_exceptions')).rows[0]!.n, 1);
    // No operator configured: «Не получилось», nothing kept as sent; once configured, «Да» again sends it.
    await f.pg.query("delete from system_config where key='platform_report_number'");
    f.model({ kind: 'support', support: 'x' });
    await f.say('хочу, чтобы ассистент умел принимать оплату');
    assert.equal((await f.say('да')).last.text, 'Не получилось передать в BizGenie. Попробуйте ещё раз чуть позже.');
    assert.equal((await f.pg.query<{ n: number }>('select count(*)::int n from support_requests')).rows[0]!.n, 0);
    await f.pg.query("insert into system_config(key,value) values('platform_report_number',to_jsonb($1::text))", [operator]);
    assert.equal((await f.say('да')).last.text, 'Передала в BizGenie');
    assert.equal((await f.pg.query<{ n: number }>('select count(*)::int n from support_requests')).rows[0]!.n, 1);
    // Z15 review: the message is queued but binding it to the request fails — the request stays, the owner hears «Передала».
    await f.pg.query('alter table support_requests add constraint z15_bind check (cardinality(operator_message_ids) = 0) not valid');
    f.model({ kind: 'support', support: 'x' });
    await f.say('пусть ассистент присылает мне голосовые');
    assert.equal((await f.say('да')).last.text, 'Передала в BizGenie');
    assert.equal(f.sent.filter(m => m.chatId === supportGroup).length, 2, 'the operator got it');
    assert.equal((await f.pg.query<{ n: number }>('select count(*)::int n from support_requests')).rows[0]!.n, 2, 'the sent request is kept');
    assert.equal((await f.pg.query<{ status: string }>("select status from owner_rule_proposals where action='support' order by created_at desc limit 1")).rows[0]!.status, 'applied');
    // The operator's quote of the unbound message still reaches the owner and closes that request.
    const unbound = f.sent.filter(m => m.chatId === supportGroup).at(-1)!;
    await handleOwnerGroupMessage(f.db, f.platformId, { event: 'message', session: 'platform', payload: { id: `false_${supportGroup}_OP2_111111111@lid`, from: supportGroup,
      participant: '111111111@lid', fromMe: false, body: 'Голосовых пока нет.', replyTo: { id: unbound.id.split('_')[2]! }, _data: { Info: { Chat: supportGroup, Sender: '111111111@lid', SenderAlt: `${operator}@s.whatsapp.net` } } } }, f.provider, null);
    await settleAllOutboundQueues();
    assert.deepEqual([f.sent.at(-1)!.chatId, f.sent.at(-1)!.text], [group, 'Ответ BizGenie: «Голосовых пока нет.»\n\nОтветьте реплеем, если нужно уточнить.'], 'the answer is not lost');
    assert.equal((await f.pg.query<{ status: string }>("select status from support_requests where text like 'пусть%'")).rows[0]!.status, 'answered');
  } finally { console.error = error; await f.close(); }
});
