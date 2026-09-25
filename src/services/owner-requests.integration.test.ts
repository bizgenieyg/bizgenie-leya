import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { createTestDatabase, pgliteDatabaseClient } from './test-support/pglite-harness.js';
import { settleAllOutboundQueues, stopOutboundQueue } from '../workers/outbound-queue.js';
import { handleOwnerMessage } from './owner-workflow.service.js';
import { loadOwnerSettings } from './owner-settings.service.js';
import { deliverOwnerSummaryIfDue } from './owner-summary.service.js';
import { simulateCustomerMessage } from './simulator.service.js';
import { discoveryQuestions, discoverySet, DISCOVERY_DEFAULTS } from '../config/discovery.js';
import { isRepeat } from './message-pipeline.service.js';
import { mergeClientProfile } from './client-profile.service.js';
process.env.GEMINI_API_KEY = '';
process.env.SUPABASE_URL = 'https://database.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';

const owner = '972500000002@c.us';
const classifier = '{"agent":"SALE","confidence":0.95}';
async function fixture(options: { sector?: string; behavior?: Record<string, unknown> } = {}) {
  const pg = await createTestDatabase();
  const db = pgliteDatabaseClient(pg);
  const tenantId = ((await db.from('tenants').insert({ name: 'Юрий', business_name: 'BizGenie', language: 'ru', tier: 'basic', status: 'active', business_sector: options.sector ?? null }).select('id').single()).data as { id: string }).id;
  await pg.query("insert into notification_settings(tenant_id,owner_phone,owner_chat_id,mode,time_zone,auto_replies_paused,behavior) values($1,'972500000002',$2,'mute_all','Asia/Jerusalem',false,$3)", [tenantId, owner, JSON.stringify(options.behavior ?? {})]);
  await pg.query("insert into plans(code,display_name,messages_per_month,voice_minutes_per_month,warning_percent,unlimited) values('basic','Базовый',500,60,80,false) on conflict(code) do nothing");
  await pg.query("insert into tenant_usage_limits(tenant_id,plan,messages_per_month,voice_minutes_per_month,warning_percent,messages_overridden,voice_overridden,warning_overridden) values($1,'basic',500,60,80,false,false,false)", [tenantId]);
  await pg.query("insert into assistant_profiles(tenant_id,assistant_name,allowed_languages,tone) values($1,'Leya',array['ru'],'friendly_professional')", [tenantId]);
  await pg.query("insert into knowledge_items(tenant_id,type,question,answer,active) values($1,'faq','Как начать?','Напишите «хочу демо» — и Юрий договорится о встрече.',true)", [tenantId]);
  const sent: { chatId: string; text: string; id: string }[] = [];
  const provider: WhatsAppProvider = {
    async getSessionStatus() { return { status: 'WORKING', me: { id: '972500000009@c.us', lid: '99999999@lid' } }; },
    async sendMessage(input) { const id = `true_${input.chatId}_MSG${sent.length}`; sent.push({ ...input, id }); return { id }; },
  };
  const send = async (chat: string, id: string, text: string, ai: unknown, phone = '972501234567') => {
    const { handleWebhookEvent } = await import('../workers/webhook.worker.js');
    await handleWebhookEvent(tenantId, { event: 'message', payload: { id, from: chat, fromMe: false, hasMedia: false, body: text, author: null, replyTo: null,
      _data: { Info: { PushName: chat.startsWith('1') ? 'Ира' : 'Дана', Chat: chat, SenderAlt: `${phone}@s.whatsapp.net` } } } }, db, provider, ai as never);
    await settleAllOutboundQueues();
  };
  return { pg, db, tenantId, sent, provider, send, toOwner: () => sent.filter(m => m.chatId === owner),
    toClient: (chat: string) => sent.filter(m => m.chatId === chat), async close() { await stopOutboundQueue(db); await pg.close(); } };
}
/** Scripted model: classifier, then the given structured replies in order; records every answer prompt. */
function model(replies: Array<Record<string, unknown>>, prompts: Array<{ system: string; user: Record<string, unknown> }> = []) {
  return { async generateReply(input: { systemPrompt: string; userMessage: string }) {
    if (input.systemPrompt.includes('классификатор')) return { text: classifier };
    if (input.systemPrompt.startsWith('Ты проверяющий')) return { text: '{"adds_facts":false,"changes_meaning":false}' };
    if (input.systemPrompt.startsWith('Ты ассистент владельца бизнеса. Владелец ответил')) return { text: 'Юрий ждёт вас в четверг в 11:00.' };
    if (input.systemPrompt.includes('пополнять базу знаний')) return { text: '{"useful":false}' };
    prompts.push({ system: input.systemPrompt, user: JSON.parse(input.userMessage) });
    return { text: JSON.stringify(replies.shift() ?? { reply: null, unanswered: [] }) };
  } };
}

test('"хочу демо" becomes one owner request; a repeat extends it silently; the owner reply reaches the client polished', async () => {
  const f = await fixture();
  const chat = '261885798707406@lid';
  try {
    const ai = model([{ reply: null, unanswered: [], request: { summary: 'Хочет демо ассистента', time: null }, profile: null },
      { reply: 'Уже передала — Юрий свяжется с вами.', unanswered: [], request: { summary: 'Удобно в четверг утром', time: 'четверг утром' }, profile: null }]);
    await f.send(chat, 'm1', 'хочу демо', ai);
    assert.equal(f.toClient(chat).at(-1)!.text, 'Передала вашу заявку — Юрий свяжется с вами.');
    assert.equal(f.toOwner().length, 1);
    assert.equal(f.toOwner()[0]!.text, '📩 Заявка: Дана (+972 50-123-4567)\nХочет демо ассистента\n\nОтветьте реплеем — я передам клиенту.');
    await f.send(chat, 'm2', 'хочу демо, можно в четверг утром?', ai);
    assert.equal(f.toOwner().length, 1, 'no new owner message for a repeat');
    assert.equal(f.toClient(chat).at(-1)!.text, 'Уже передала — Юрий свяжется с вами.');
    const rows = (await f.pg.query<{ kind: string; question: string; status: string }>('select kind,question,status from escalations')).rows;
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { kind: 'request', status: 'pending', question: 'Хочет демо ассистента\nУдобно в четверг утром\nВремя: четверг утром' });
    const settings = await loadOwnerSettings(f.db, f.tenantId);
    await handleOwnerMessage(f.db, f.provider, f.tenantId, 'session', owner, 'четверг 11:00 ок', f.toOwner()[0]!.id, settings, ai as never); await settleAllOutboundQueues();
    assert.equal(f.toClient(chat).at(-1)!.text, 'Юрий ждёт вас в четверг в 11:00.');
    assert.equal((await f.pg.query<{ status: string }>('select status from escalations')).rows[0]!.status, 'delivered');
  } finally { await f.close(); }
});

test('"запишите меня на четверг" is a request with the named time', async () => {
  const f = await fixture();
  const chat = '261885798707406@lid';
  try {
    await f.send(chat, 'm1', 'запишите меня на четверг', model([{ reply: null, unanswered: [], request: { summary: 'Хочет записаться', time: 'четверг' } }]));
    assert.match(f.toOwner()[0]!.text, /^📩 Заявка: Дана \(\+972 50-123-4567\)\nХочет записаться\nВремя: четверг\n\n/);
  } finally { await f.close(); }
});

test('morning summary shows the open questions and a separate block of unanswered requests', async () => {
  const f = await fixture({ behavior: { summary_frequency: 'daily', summary_time: '00:00' } });
  try {
    await f.send('261885798707406@lid', 'q1', 'есть парковка?', model([{ reply: null, unanswered: ['Есть парковка?'] }]));
    await f.send('11111111@lid', 'r1', 'хочу демо', model([{ reply: null, unanswered: [], request: { summary: 'Хочет демо', time: null } }]), '972501110000');
    await f.send('22222222@lid', 'r2', 'перезвоните мне', model([{ reply: null, unanswered: [], request: { summary: 'Просит перезвонить', time: null } }]), '972502220000');
    await deliverOwnerSummaryIfDue(f.db, f.tenantId, 'session', f.provider, new Date()); await settleAllOutboundQueues();
    const summary = f.toOwner().at(-1)!.text;
    assert.match(summary, /ждут ответа — 1\./);
    assert.match(summary, /Заявки без ответа: 2\n- Ира — Хочет демо\n- Дана — Просит перезвонить/);
  } finally { await f.close(); }
});

test('discovery: sector picks the starter set; the prompt asks at most one question from it', async () => {
  assert.equal(discoverySet('косметолог'), 'beauty');
  assert.equal(discoverySet('Автоматизация бизнеса'), 'business');
  assert.equal(discoverySet('קייטרינג'), 'food');
  assert.equal(discoverySet(null), 'other');
  assert.deepEqual(discoveryQuestions([], 'косметолог', 'ru'), DISCOVERY_DEFAULTS.beauty.ru);
  assert.deepEqual(discoveryQuestions(['Свой вопрос?'], 'косметолог', 'ru'), ['Свой вопрос?']);
  const f = await fixture({ sector: 'автоматизация' });
  try {
    const prompts: Array<{ system: string; user: Record<string, unknown> }> = [];
    await f.send('261885798707406@lid', 'm1', 'хотел узнать о ваших услугах', model([{ reply: 'Делаем WhatsApp-ассистентов. Чем занимается ваш бизнес?', unanswered: [] }], prompts));
    assert.match(prompts[0]!.system, /Не больше одного вопроса из списка за сообщение/);
    for (const question of DISCOVERY_DEFAULTS.business.ru) assert.ok(prompts[0]!.system.includes(question), question);
    assert.match(prompts[0]!.system, /Медицинские вопросы/);
    assert.equal(f.toClient('261885798707406@lid').at(-1)!.text, 'Делаем WhatsApp-ассистентов. Чем занимается ваш бизнес?');
  } finally { await f.close(); }
});

test('profile: a new fact lands in client_profiles, reaches the next prompt, owner notes untouched', async () => {
  const f = await fixture({ sector: 'косметолог' });
  const chat = '261885798707406@lid';
  try {
    const prompts: Array<{ system: string; user: Record<string, unknown> }> = [];
    const ai = model([{ reply: 'Чистка лица занимает час. Когда удобно прийти?', unanswered: [], profile: ['впервые, интересует чистка лица'] },
      { reply: 'Есть окно в пятницу утром.', unanswered: [], profile: null }], prompts);
    await f.pg.query("insert into clients(tenant_id,phone,whatsapp_jid,notes) values($1,'972501234567',$2,'VIP — заметка владельца')", [f.tenantId, chat]);
    await f.send(chat, 'm1', 'я впервые, интересует чистка', ai);
    const profile = (await f.pg.query<{ profile_md: string }>('select profile_md from client_profiles')).rows[0]!.profile_md;
    assert.match(profile, /^- \d{2}\.\d{2}: впервые, интересует чистка лица$/);
    await f.send(chat, 'm2', 'а что по времени?', ai);
    assert.equal(prompts[1]!.user.clientProfile, profile);
    assert.equal((await f.pg.query<{ notes: string }>('select notes from clients')).rows[0]!.notes, 'VIP — заметка владельца');
  } finally { await f.close(); }
});

test('profile merge keeps dates of known facts, replaces changed ones, trims the oldest over the limit', () => {
  const now = new Date('2026-09-25T10:00:00Z');
  const first = mergeClientProfile('', ['впервые', 'интересует чистка'], now, 'Asia/Jerusalem')!;
  assert.equal(first, '- 25.09: впервые\n- 25.09: интересует чистка');
  const later = mergeClientProfile(first, ['впервые', 'интересует пилинг'], new Date('2026-09-27T10:00:00Z'), 'Asia/Jerusalem')!;
  assert.equal(later, '- 25.09: впервые\n- 27.09: интересует пилинг');
  assert.equal(mergeClientProfile(later, ['впервые', 'интересует пилинг'], now, 'Asia/Jerusalem'), null);
  const long = mergeClientProfile('', Array.from({ length: 20 }, (_, i) => `факт ${i} `.repeat(15)), now, 'Asia/Jerusalem')!;
  assert.ok(long.length <= 2000 && long.includes('факт 19'));
});

test('a repeated reply is regenerated once and never sent twice; a request instead goes to the owner', async () => {
  assert.equal(isRepeat('Напишите «хочу демо» — и Юрий договорится.', 'напишите хочу демо и юрий договорится'), true);
  assert.equal(isRepeat('Напишите «хочу демо» — и Юрий договорится!!', 'Напишите «хочу демо» — и Юрий договорится.'), true);
  assert.equal(isRepeat('Чистка лица занимает час.', 'Пилинг стоит 200 ₪.'), false);
  const X = 'Напишите «хочу демо» — и Юрий договорится о встрече.';
  const f = await fixture();
  const chat = '261885798707406@lid';
  try {
    const conv = await f.pg.query<{ id: string }>("with c as (insert into clients(tenant_id,phone,whatsapp_jid) values($1,'972501234567',$2) returning id) insert into conversations(tenant_id,client_id,status,assistant_introduced_at) select $1,id,'active',now() from c returning id", [f.tenantId, chat]);
    await f.pg.query("insert into messages(tenant_id,conversation_id,from_me,body,msg_type) values($1,$2,true,$3,'text')", [f.tenantId, conv.rows[0]!.id, X]);
    const prompts: Array<{ system: string; user: Record<string, unknown> }> = [];
    await f.send(chat, 'm1', 'хочу демо', model([{ reply: X, unanswered: [] }, { reply: X, unanswered: [] }], prompts));
    assert.equal(prompts.length, 2);
    assert.match(prompts[1]!.system, /НЕ ПОВТОРЯЙСЯ/);
    assert.ok(f.toClient(chat).every(m => m.text !== X), 'X is never sent again');
    const esc = (await f.pg.query<{ kind: string; question: string }>('select kind,question from escalations')).rows;
    assert.deepEqual(esc, [{ kind: 'question', question: 'хочу демо' }]);
  } finally { await f.close(); }
  const g = await fixture();
  try {
    const conv = await g.pg.query<{ id: string }>("with c as (insert into clients(tenant_id,phone,whatsapp_jid) values($1,'972501234567',$2) returning id) insert into conversations(tenant_id,client_id,status,assistant_introduced_at) select $1,id,'active',now() from c returning id", [g.tenantId, chat]);
    await g.pg.query("insert into messages(tenant_id,conversation_id,from_me,body,msg_type) values($1,$2,true,$3,'text')", [g.tenantId, conv.rows[0]!.id, X]);
    await g.send(chat, 'm1', 'хочу демо', model([{ reply: X, unanswered: [] }, { reply: null, unanswered: [], request: { summary: 'Хочет демо', time: null } }]));
    assert.equal(g.toClient(chat).at(-1)!.text, 'Передала вашу заявку — Юрий свяжется с вами.');
    assert.equal((await g.pg.query<{ kind: string }>('select kind from escalations')).rows[0]!.kind, 'request');
  } finally { await g.close(); }
});

test('simulator follows the same path: request, repeat and profile stored per simulator session', async () => {
  const f = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'leya-sim-i-'));
  try {
    const session = crypto.randomUUID();
    const ai = model([{ reply: null, unanswered: [], request: { summary: 'Хочет демо', time: null }, profile: ['интересует демо'] },
      { reply: 'Уже передала — Юрий свяжется с вами.', unanswered: [], request: { summary: 'Хочет демо', time: null } }]);
    const first = await simulateCustomerMessage(f.db, f.tenantId, session, 'хочу демо', ai as never, { root });
    assert.equal(first.reply, 'Передала вашу заявку — Юрий свяжется с вами.');
    assert.equal(first.outcome, 'escalated');
    const second = await simulateCustomerMessage(f.db, f.tenantId, session, 'хочу демо', ai as never, { root });
    assert.equal(second.reply, 'Уже передала — Юрий свяжется с вами.');
    const state = (await f.pg.query<{ open_request: string; profile_md: string }>('select open_request,profile_md from simulator_sessions where id=$1', [session])).rows[0]!;
    assert.equal(state.open_request, 'Хочет демо');
    assert.match(state.profile_md, /интересует демо/);
    for (const table of ['escalations', 'client_profiles']) assert.equal((await f.pg.query<{ n: number }>(`select count(*)::int n from ${table}`)).rows[0]!.n, 0, table);
    const fresh = crypto.randomUUID();
    await simulateCustomerMessage(f.db, f.tenantId, fresh, 'привет', model([{ reply: 'Здравствуйте.', unanswered: [] }]) as never, { root });
    assert.equal((await f.pg.query<{ profile_md: string }>('select profile_md from simulator_sessions where id=$1', [fresh])).rows[0]!.profile_md, '', 'a new simulator dialogue starts with an empty profile');
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});

test('the database rejects a client profile longer than 2000 characters (client and simulator)', async () => {
  const f = await fixture();
  try {
    const client = (await f.pg.query<{ id: string }>("insert into clients(tenant_id,phone,whatsapp_jid) values($1,'972501234567','972501234567@c.us') returning id", [f.tenantId])).rows[0]!.id;
    await f.pg.query('insert into client_profiles(tenant_id,client_id,profile_md) values($1,$2,$3)', [f.tenantId, client, 'x'.repeat(2000)]);
    await assert.rejects(f.pg.query('update client_profiles set profile_md=$1', ['x'.repeat(2001)]), /client_profiles_profile_length/);
    await assert.rejects(f.pg.query('insert into simulator_sessions(tenant_id,id,profile_md) values($1,$2,$3)', [f.tenantId, crypto.randomUUID(), 'x'.repeat(2001)]), /check constraint/);
  } finally { await f.close(); }
});
