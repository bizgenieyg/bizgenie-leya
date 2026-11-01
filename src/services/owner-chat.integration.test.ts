import assert from 'node:assert/strict';
import test from 'node:test';
import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { createTestDatabase, pgliteDatabaseClient } from './test-support/pglite-harness.js';
import { OWNER_GROUPS, seedOwnerGroups } from './test-support/owner-groups.js';
import { handleOwnerMessage } from './owner-workflow.service.js';
import { invalidateOwnerSettings, loadOwnerSettings } from './owner-settings.service.js';
import { handleOwnerGroupMessage } from './owner-group-inbound.service.js';
import { sendPendingHints } from './owner-channels.service.js';
import { settleAllOutboundQueues, stopOutboundQueue } from '../workers/outbound-queue.js';

process.env.GEMINI_API_KEY = '';
process.env.SUPABASE_URL = 'https://database.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';

const owner = '972500000002@c.us', group = OWNER_GROUPS.needsAnswer, supportGroup = '120363000000099@g.us', operator = '972500000077';
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
    assert.equal((await f.say('у меня проблема, ассистент не ответил клиентке вчера вечером')).last.text, 'Передать в BizGenie: «Ассистент не ответил клиентке вчера вечером»? Да / Нет');
    assert.equal((await f.pg.query<{ n: number }>('select count(*)::int n from support_requests')).rows[0]!.n, 0, 'nothing before «Да»');
    assert.equal((await f.say('да')).last.text, 'Передала в BizGenie');
    assert.deepEqual(f.groups, [{ session: 'platform', name: 'BizGenie · Поддержка', participants: [`${operator}@c.us`] }]);
    const toOperator = f.sent.find(m => m.chatId === supportGroup)!;
    assert.equal(toOperator.session, 'platform');
    assert.equal(toOperator.text, '🛟 Ноготки (Ира): «Ассистент не ответил клиентке вчера вечером»\nОтветьте реплеем — передам владельцу.');
    const row = (await f.pg.query<{ tenant_id: string; status: string }>('select tenant_id,status from support_requests')).rows[0]!;
    assert.deepEqual(row, { tenant_id: f.tenantId, status: 'new' });
    assert.equal((await f.pg.query<{ v: string }>("select value#>>'{}' v from system_config where key='support_group_chat'")).rows[0]!.v, supportGroup);
    // The operator answers by a quote in the support group.
    const short = toOperator.id.split('_')[2]!;
    await handleOwnerGroupMessage(f.db, f.platformId, { event: 'message', session: 'platform', payload: { id: `false_${supportGroup}_OP1_${operator}@c.us`, from: supportGroup, participant: '111111111@lid', fromMe: false, body: 'Посмотрел — была пауза диалога, сейчас всё работает.', replyTo: { id: short } } }, f.provider, null);
    await settleAllOutboundQueues();
    const answer = f.sent.at(-1)!;
    assert.deepEqual([answer.session, answer.chatId, answer.text], ['session', group, 'Ответ BizGenie: «Посмотрел — была пауза диалога, сейчас всё работает.»']);
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
    await f.say('передай Юрию, что ассистент выдумал доставку', 'ANS1');
    await f.say('да');
    assert.deepEqual((await f.pg.query('select quoted_text,conversation_id from support_requests')).rows[0], { quoted_text: 'Доставим завтра до обеда.', conversation_id: conversation });
    assert.match(f.sent.find(m => m.chatId === supportGroup)!.text, /\nК ответу ассистента: «Доставим завтра до обеда\.»\n/);
  } finally { await f.close(); }
});

test('Z15: the hint goes once to a «Нужен ответ» group created before — description and first message', async () => {
  const f = await fixture();
  try {
    await f.pg.query('update owner_channels set hint_sent_at=null');
    await sendPendingHints(f.db, () => f.provider);
    await settleAllOutboundQueues();
    await sendPendingHints(f.db, () => f.provider);
    await settleAllOutboundQueues();
    assert.deepEqual(f.sent.map(m => [m.chatId, m.text]), [[group, HELP]], 'once, only to «Нужен ответ»');
    assert.deepEqual(f.descriptions, [HELP]);
  } finally { await f.close(); }
});
