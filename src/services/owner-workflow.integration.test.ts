import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import type { DatabaseClient } from '../db/supabase.js';
import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { conversationPaused, createEscalation, handleOwnerMessage, runDueScheduledEscalations } from './owner-workflow.service.js';
import { invalidateOwnerSettings, saveOwnerSettings, type OwnerSettings } from './owner-settings.service.js';
import { isWithinQuietHours, nextQuietHoursEnd } from './escalation.service.js';
import { observeOwnerOutgoing } from './outgoing-owner.service.js';
import { enqueueMessage } from '../workers/outbound-queue.js';
import { clientText, isDeferredAnswer, replyId } from '../utils/assistant-text.js';
import { createTestDatabase, pgliteDatabaseClient } from './test-support/pglite-harness.js';

// Converted to PGlite (real migrations, real Postgres types/constraints/RPCs) per review.
// The previous hand-rolled in-memory mock accepted plain strings ('conversation', 'e',
// 'other-tenant') as ids on columns that are `uuid` in the real schema, ran its own
// simplified re-implementation of `admit_tenant_usage`/`confirm_escalation_learning`
// instead of the real SQL functions, and never enforced the escalations CHECK
// constraints or the compound (conversation_id, tenant_id) foreign key. Running the
// same service code against a real Postgres schema is what would have caught the
// simulator's non-UUID id (see simulator.service.ts git history) — this file guards
// the escalation/owner-reply/timeout paths against the same class of gap.
process.env.SUPABASE_URL = 'https://database.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';
process.env.GEMINI_API_KEY = '';

const owner = '972500000002@c.us';
const customer = '261885798707406@lid';
const defaultsFor = (tenant: string): OwnerSettings => ({ owner_phone: '972500000002', owner_chat_id: owner, mode: 'mute_all', time_zone: 'Asia/Jerusalem', quiet_hours_start: null, quiet_hours_end: null, auto_replies_paused: false });

async function pgHarness() {
  const pg: PGlite = await createTestDatabase();
  const db = pgliteDatabaseClient(pg);
  const tenant = (await db.from('tenants').insert({ name: 'Business', business_name: 'Business', phone: '972500000001', language: 'ru', tier: 'basic', status: 'active' }).select('id').single()).data as { id: string };
  const tenantId = tenant.id;
  await pg.query('insert into notification_settings(tenant_id,owner_phone,owner_chat_id,mode,time_zone,auto_replies_paused) values($1,$2,$3,$4,$5,false)', [tenantId, '972500000002', owner, 'mute_all', 'Asia/Jerusalem']);
  await pg.query("insert into plans(code,display_name,messages_per_month,voice_minutes_per_month,warning_percent,unlimited) values('basic','Базовый',500,60,80,false) on conflict(code) do nothing");
  await pg.query('insert into tenant_usage_limits(tenant_id,plan,messages_per_month,voice_minutes_per_month,warning_percent,messages_overridden,voice_overridden,warning_overridden) values($1,\'basic\',500,60,80,false,false,false)', [tenantId]);
  const clientRow = (await db.from('clients').insert({ tenant_id: tenantId, phone: customer, whatsapp_jid: customer, name: 'Клиент' }).select('id').single()).data as { id: string };
  const conversation = (await db.from('conversations').insert({ tenant_id: tenantId, client_id: clientRow.id, status: 'active', bot_paused: false }).select('id').single()).data as { id: string };

  const sent: { chatId: string; text: string; id: string; replyTo?: string }[] = [];
  let failClient = false;
  const provider: WhatsAppProvider = {
    async getSessionStatus() { return { status: 'WORKING', me: { id: '972500000009@c.us', lid: '99999999@lid' } }; },
    async sendMessage(input) {
      if (failClient && input.chatId === customer) throw new Error('network');
      const id = `true_${input.chatId}_MSG${sent.length}`;
      sent.push({ ...input, id });
      return { id };
    },
  };

  const admissionCount = async () => Number((await pg.query<{ count: string }>("select count(*)::text as count from usage_events where tenant_id=$1 and event_type='message_received'", [tenantId])).rows[0]!.count);
  const settings = defaultsFor(tenantId);
  return {
    pg, db, tenant: tenantId, conversationId: conversation.id, clientId: clientRow.id, provider, sent, settings,
    admissions: admissionCount,
    deny: async () => { await pg.query("update tenant_usage_limits set messages_per_month=0,messages_overridden=true where tenant_id=$1", [tenantId]); },
    fail: () => { failClient = true; },
    escalation: async (id: string) => (await pg.query('select * from escalations where id=$1', [id])).rows[0] as Record<string, unknown> & { id: string; status: string; owner_message_ids: string[]; learning_message_ids: string[]; learning_state: string; client_message_id: string | null },
    conversation: async () => (await pg.query('select * from conversations where id=$1', [conversation.id])).rows[0] as Record<string, unknown> & { bot_paused: boolean; owner_last_activity_at: string | null; assistant_introduced_at: string | null },
    notificationSettings: async () => (await pg.query('select * from notification_settings where tenant_id=$1', [tenantId])).rows[0] as Record<string, unknown> & { auto_replies_paused: boolean },
    knowledgeCount: async () => Number((await pg.query<{ count: string }>('select count(*)::text as count from knowledge_items where tenant_id=$1', [tenantId])).rows[0]!.count),
  };
}
async function seedEscalation(h: Awaited<ReturnType<typeof pgHarness>>, overrides: Partial<{ question: string; created_at: string }> = {}) {
  const row = (await h.db.from('escalations').insert({
    tenant_id: h.tenant, conversation_id: h.conversationId, client_chat_id: customer, client_name: 'Тестовый клиент',
    question: overrides.question ?? 'Можно завтра?', session: 'session', inbound_id: 'incoming', ...overrides,
  }).select('id').single()).data as { id: string };
  return row.id;
}

test('owner reply: short GOWS ID, delivery before closure, quoted confirmation only and tenant isolation', async () => {
  const h = await pgHarness();
  const input = { tenant_id: h.tenant, conversation_id: h.conversationId, client_chat_id: customer, client_name: 'Тестовый клиент', question: 'Можно завтра?', session: 'session', inbound_id: 'incoming' };
  await createEscalation(h.db, h.provider, input, h.settings);
  assert.equal((await h.pg.query<{count:number}>("select count(*)::int as count from scheduled_jobs where job_type='escalation_timeout' and status='pending'")).rows[0]!.count, 1);
  assert.equal(h.sent.length, 2); assert.match(h.sent[0]!.text, /ассистент владельца/); assert.equal(h.sent[1]!.chatId, owner);
  let e = await h.escalation((await h.pg.query<{ id: string }>('select id from escalations limit 1')).rows[0]!.id);
  assert.equal(e.status, 'pending');
  assert.match(h.sent[1]!.text, /Тестовый клиент/);

  await handleOwnerMessage(h.db, h.provider, randomUUID(), 'session', owner, 'Ответ', replyId(h.sent[1]!.id), h.settings);
  e = await h.escalation(e.id); assert.equal(e.status, 'pending'); assert.equal(h.sent.length, 2);

  await handleOwnerMessage(h.db, h.provider, h.tenant, 'session', owner, 'Завтра отвечу', e.owner_message_ids[0]!, h.settings);
  e = await h.escalation(e.id); assert.equal(e.status, 'pending'); assert.equal(await h.knowledgeCount(), 0);

  await handleOwnerMessage(h.db, h.provider, h.tenant, 'session', owner, 'Да, можно', e.owner_message_ids[0]!, h.settings);
  e = await h.escalation(e.id); assert.equal(e.status, 'delivered'); assert.ok(e.client_message_id);
  assert.equal((await h.pg.query<{count:number}>("select count(*)::int as count from scheduled_jobs where job_type='escalation_timeout' and status='cancelled'")).rows[0]!.count, 1);
  assert.equal(h.sent.at(-2)!.chatId, customer); assert.equal(h.sent.at(-2)!.replyTo, undefined);
  assert.match(h.sent.at(-2)!.text, /Передаю ответ владельца/); assert.equal(await h.knowledgeCount(), 0);

  const prompt = e.learning_message_ids[0]!;
  assert.equal(await handleOwnerMessage(h.db, h.provider, h.tenant, 'session', customer, 'Да', prompt, h.settings), false);
  assert.equal(await h.knowledgeCount(), 0);
  await handleOwnerMessage(h.db, h.provider, h.tenant, 'session', owner, 'Да', prompt, h.settings);
  await handleOwnerMessage(h.db, h.provider, h.tenant, 'session', owner, 'Да', prompt, h.settings);
  assert.equal(await h.knowledgeCount(), 1);
  e = await h.escalation(e.id); assert.equal(e.learning_state, 'saved');
});

test('failed client delivery leaves escalation open and never offers learning', async () => {
  const h = await pgHarness();
  const input = { tenant_id: h.tenant, conversation_id: h.conversationId, client_chat_id: customer, client_name: 'Тестовый клиент', question: 'Можно завтра?', session: 'session', inbound_id: 'incoming' };
  await createEscalation(h.db, h.provider, input, h.settings); h.fail();
  await h.pg.query("update notification_settings set behavior=jsonb_set(coalesce(behavior,'{}'::jsonb),'{outbound_retry_delays_seconds}','[0,0,0]'::jsonb) where tenant_id=$1", [h.tenant]);
  invalidateOwnerSettings(h.db,h.tenant);
  let e = await h.escalation((await h.pg.query<{ id: string }>('select id from escalations limit 1')).rows[0]!.id);
  await handleOwnerMessage(h.db, h.provider, h.tenant, 'session', owner, 'Ответ', e.owner_message_ids[0]!, h.settings);
  e = await h.escalation(e.id);
  assert.equal(e.status, 'delivery_uncertain'); assert.equal(e.learning_state, 'none'); assert.equal(await h.knowledgeCount(), 0);
});

test('createEscalation with an all-day-off schedule promises a callback and escalates now', async () => {
  const h = await pgHarness();
  const input = { tenant_id: h.tenant, conversation_id: h.conversationId, client_chat_id: customer, client_name: 'Тестовый клиент', question: 'Можно завтра?', session: 'session', inbound_id: 'incoming' };
  const closed = { ...h.settings, behavior: { weekly_schedule: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [String(i), { mode: 'day_off' }])) } };
  const before = Date.now();
  await createEscalation(h.db, h.provider, input, closed);
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[0]!.text, /свяжется с вами/);
  assert.doesNotMatch(h.sent[0]!.text, /\d{1,2}:\d{2}/);
  assert.equal(h.sent[1]!.chatId, owner);
  const job = (await h.pg.query<{ scheduled_at: string }>('select scheduled_at from scheduled_jobs limit 1')).rows[0]!;
  assert.ok(new Date(job.scheduled_at).getTime() - before < 5 * 60 * 1000);
});

test('takeover, tenant pause and explicit resume remain separate', async () => {
  const h = await pgHarness();
  const input = { tenant_id: h.tenant, conversation_id: h.conversationId, client_chat_id: customer, client_name: 'Тестовый клиент', question: 'Можно завтра?', session: 'session', inbound_id: 'incoming' };
  await createEscalation(h.db, h.provider, input, h.settings);
  let e = await h.escalation((await h.pg.query<{ id: string }>('select id from escalations limit 1')).rows[0]!.id);
  await handleOwnerMessage(h.db, h.provider, h.tenant, 'session', owner, 'Беру на себя', e.owner_message_ids[0]!, h.settings);
  assert.equal((await h.conversation()).bot_paused, true);
  await handleOwnerMessage(h.db, h.provider, h.tenant, 'session', owner, 'Ответ', e.owner_message_ids[0]!, h.settings);
  e = await h.escalation(e.id); assert.equal(e.status, 'pending');
  await handleOwnerMessage(h.db, h.provider, h.tenant, 'session', owner, 'Пауза всё', null, h.settings);
  assert.equal((await h.notificationSettings()).auto_replies_paused, true);
  await handleOwnerMessage(h.db, h.provider, h.tenant, 'session', owner, 'Продолжить всё', null, h.settings);
  assert.equal((await h.conversation()).bot_paused, true);
  await handleOwnerMessage(h.db, h.provider, h.tenant, 'session', owner, 'Продолжить', e.owner_message_ids[0]!, h.settings);
  assert.equal((await h.conversation()).bot_paused, false);
});

test('manual fromMe send pauses dialogue and closes pending escalation; API send is ignored', async () => {
  const h = await pgHarness();
  await seedEscalation(h, { created_at: '2026-09-08T10:00:00Z' });
  const body = { event: 'message', payload: { id: 'manual-1', from: '972500000009@c.us', to: customer, fromMe: true, source: 'app', body: 'Ответ владельца', _data: { Info: { IsFromMe: true, Chat: customer } } } };
  assert.equal(await observeOwnerOutgoing(h.db, h.tenant, body, new Date('2026-09-08T20:00:00Z')), true);
  assert.equal((await h.conversation()).bot_paused, true);
  const e = await h.pg.query<{ status: string }>('select status from escalations limit 1');
  assert.equal(e.rows[0]!.status, 'resolved_by_owner');
  assert.equal(await observeOwnerOutgoing(h.db, h.tenant, { ...body, payload: { ...body.payload, id: 'api-1', source: 'api' } }, new Date()), false);
});

test('automatic resume is disabled by default and enabled after configured inactivity', async () => {
  const h = await pgHarness();
  await h.pg.query("update conversations set bot_paused=true,owner_last_activity_at='2026-09-08T10:00:00Z' where id=$1", [h.conversationId]);
  assert.equal(await conversationPaused(h.db, h.tenant, h.conversationId, h.settings, new Date('2026-09-09T10:00:00Z')), true);
  assert.equal(await conversationPaused(h.db, h.tenant, h.conversationId, { ...h.settings, behavior: { auto_resume_hours: 12 } }, new Date('2026-09-09T10:00:00Z')), false);
  assert.equal((await h.conversation()).bot_paused, false);
});

test('quiet queue uses Jerusalem time, delivers each once across concurrent schedulers', async () => {
  const h = await pgHarness();
  const night = { ...h.settings, quiet_hours_start: '20:00', quiet_hours_end: '09:00' };
  assert.equal(isWithinQuietHours(night, new Date('2026-09-08T18:00:00Z')), true);
  assert.equal(nextQuietHoursEnd(night, new Date('2026-09-08T18:00:00Z'))!.toISOString(), '2026-09-09T06:00:00.000Z');
  assert.equal(nextQuietHoursEnd(night, new Date('2026-10-24T18:00:00Z'))!.toISOString(), '2026-10-25T07:00:00.000Z');
  await h.pg.query('update notification_settings set quiet_hours_start=$2,quiet_hours_end=$3 where tenant_id=$1', [h.tenant, '20:00:00', '09:00:00']);
  const escalationId = await seedEscalation(h);
  await h.pg.query("update escalations set status='queued' where id=$1", [escalationId]);
  await h.pg.query("insert into scheduled_jobs(tenant_id,job_type,payload,status,scheduled_at) values($1,'owner_escalation',$2,'pending','2026-09-08T00:00:00Z')", [h.tenant, JSON.stringify({ escalation_id: escalationId })]);
  await runDueScheduledEscalations(h.db, () => h.provider, new Date('2026-09-08T18:00:00Z'));
  assert.equal(h.sent.length, 0);
  await Promise.all([runDueScheduledEscalations(h.db, () => h.provider, new Date('2026-09-09T06:00:00Z')), runDueScheduledEscalations(h.db, () => h.provider, new Date('2026-09-09T06:00:00Z'))]);
  assert.equal(h.sent.length, 1);
  assert.equal((await h.escalation(escalationId)).status, 'pending');
});

test('due escalation is cancelled after owner activity and expires after maximum age', async () => {
  for (const kind of ['owner', 'expired']) {
    const h = await pgHarness();
    const created = '2026-09-08T00:00:00Z';
    await h.pg.query("update notification_settings set behavior=$2 where tenant_id=$1", [h.tenant, JSON.stringify({ deferred_max_age_hours: 12 })]);
    if (kind === 'owner') await h.pg.query('update conversations set owner_last_activity_at=$2 where id=$1', [h.conversationId, '2026-09-08T01:00:00Z']);
    const escalationId = await seedEscalation(h, { created_at: created });
    await h.pg.query("update escalations set status='queued',created_at=$2 where id=$1", [escalationId, created]);
    await h.pg.query("insert into scheduled_jobs(tenant_id,job_type,payload,status,scheduled_at) values($1,'owner_escalation',$2,'pending',$3)", [h.tenant, JSON.stringify({ escalation_id: escalationId }), created]);
    await runDueScheduledEscalations(h.db, () => h.provider, new Date('2026-09-08T13:00:00Z'));
    assert.equal(h.sent.length, 0);
    assert.equal((await h.escalation(escalationId)).status, kind === 'owner' ? 'resolved_by_owner' : 'expired');
  }
});

test('owner phone must differ from session; one-time numeric code binds LID and is single-use', async () => {
  const h = await pgHarness();
  await assert.rejects(saveOwnerSettings(h.db, h.tenant, { phone: '972500000009' }, { id: '972500000009@c.us' }), /отличаться/);
  const result = await saveOwnerSettings(h.db, h.tenant, { phone: '972500000002', timeZone: 'Asia/Jerusalem' }, { id: '972500000009@c.us' });
  assert.match(result.code, /^\d{6}$/);
  const settings = { ...h.settings, ...(await h.notificationSettings()) } as unknown as OwnerSettings;
  // The owner just replies with the digits from the WhatsApp message we sent them —
  // no command word required — and stray punctuation around the code is tolerated.
  await handleOwnerMessage(h.db, h.provider, h.tenant, 'session', '88888888@lid', ` ${result.code}. `, null, settings);
  let row = await h.notificationSettings();
  assert.equal(row.owner_chat_id, '88888888@lid'); assert.equal(row.owner_pairing_hash, null);
  await handleOwnerMessage(h.db, h.provider, h.tenant, 'session', '77777777@lid', result.code, null, settings);
  row = await h.notificationSettings();
  assert.equal(row.owner_chat_id, '88888888@lid');
});
test('a customer\'s six-digit message is not swallowed as a pairing attempt when no pairing is pending', async () => {
  const h = await pgHarness();
  const settings = { ...h.settings, ...(await h.notificationSettings()) } as unknown as OwnerSettings;
  assert.equal(settings.owner_pairing_hash ?? null, null);
  const handled = await handleOwnerMessage(h.db, h.provider, h.tenant, 'session', customer, '123456', null, settings);
  assert.equal(handled, false);
});
test('a wrong code or the right code from an unrelated sender never binds pairing', async () => {
  const h = await pgHarness();
  const result = await saveOwnerSettings(h.db, h.tenant, { phone: '972500000002', timeZone: 'Asia/Jerusalem' }, { id: '972500000009@c.us' });
  const settings = { ...h.settings, ...(await h.notificationSettings()) } as unknown as OwnerSettings;
  const wrongCode = result.code === '000000' ? '111111' : '000000';
  await handleOwnerMessage(h.db, h.provider, h.tenant, 'session', '55555555@c.us', wrongCode, null, settings);
  assert.equal((await h.notificationSettings()).owner_chat_id, null);
  await handleOwnerMessage(h.db, h.provider, h.tenant, 'session', '55555555@c.us', result.code, null, settings);
  assert.equal((await h.notificationSettings()).owner_chat_id, null, 'a non-@lid sender must also match the owner phone');
});

test('owner phone accepts explicit international country codes from Israel and other countries', async () => {
  const h = await pgHarness();
  const result = await saveOwnerSettings(h.db, h.tenant, { phone: '+972 52-369-5741', timeZone: 'Asia/Jerusalem' }, { id: '972500000009@c.us' });
  assert.equal(result.phone, '972523695741');
  assert.equal((await h.notificationSettings()).owner_phone, '972523695741');
  const settings = { ...h.settings, ...(await h.notificationSettings()) } as unknown as OwnerSettings;
  await handleOwnerMessage(h.db, h.provider, h.tenant, 'session', '972523695741@c.us', result.code, null, settings);
  assert.equal((await h.notificationSettings()).owner_chat_id, '972523695741@c.us');

  const us = await saveOwnerSettings(h.db, h.tenant, { phone: '+15551234567', timeZone: 'America/New_York' }, { id: '972500000009@c.us' });
  assert.equal(us.phone, '15551234567');
  assert.equal((await h.notificationSettings()).owner_phone, '15551234567');
});
test('saveOwnerSettings rejects local numbers without a country code instead of guessing a country', async () => {
  const h = await pgHarness();
  for (const bad of ['0501234567', '501234567', '123', '', 'not a phone']) {
    await assert.rejects(saveOwnerSettings(h.db, h.tenant, { phone: bad, timeZone: 'Asia/Jerusalem' }, { id: '972500000009@c.us' }), /кодом страны/i);
  }
  assert.equal((await h.notificationSettings()).owner_phone, '972500000002', 'the prior valid phone from pgHarness setup is untouched');
});

test('complete real GOWS client and owner reply payloads traverse worker filters through delivery', async () => {
  const { handleWebhookEvent } = await import('../workers/webhook.worker.js');
  const h = await pgHarness();
  const body = JSON.parse(readFileSync('src/services/fixtures/gows-incoming-lid.json', 'utf8'));
  body.payload.from = customer; body.payload._data.Info.Chat = customer; body.payload.body = 'Неизвестный вопрос';
  await handleWebhookEvent(h.tenant, body, h.db, h.provider, null);
  await handleWebhookEvent(h.tenant, body, h.db, h.provider, null);
  let e = (await h.pg.query<{ id: string; status: string; client_name: string }>('select id,status,client_name from escalations limit 1')).rows[0]!;
  assert.equal(e.status, 'pending'); assert.equal(e.client_name, body.payload._data.Info.PushName);
  await h.pg.query('update notification_settings set owner_chat_id=$2 where tenant_id=$1', [h.tenant, '88888888@lid']);
  invalidateOwnerSettings(h.db, h.tenant);
  const full = await h.escalation(e.id);
  const reply = structuredClone(body);
  reply.payload.from = '88888888@lid'; reply.payload._data.Info.Chat = reply.payload.from; reply.payload.body = 'Ответ владельца'; reply.payload.replyTo = { id: full.owner_message_ids[0] };
  await handleWebhookEvent(h.tenant, reply, h.db, h.provider, null);
  assert.equal((await h.escalation(e.id)).status, 'delivered');
  await h.pg.query('update notification_settings set auto_replies_paused=true where tenant_id=$1', [h.tenant]);
  invalidateOwnerSettings(h.db, h.tenant);
  const count = h.sent.length;
  const pausedBody=structuredClone(body);pausedBody.payload.id='paused-incoming-1';pausedBody.payload.from='55555555@lid';pausedBody.payload._data.Info.Chat='55555555@lid';pausedBody.payload.body='Хочу заказать новую услугу';
  const storedBefore=Number((await h.pg.query<{count:string}>('select count(*)::text count from messages')).rows[0]!.count);
  await handleWebhookEvent(h.tenant, pausedBody, h.db, h.provider, { async generateReply(input) {return input.systemPrompt.includes('классификатор')?{text:'{"agent":"SALE","confidence":0.95}'}:{text:'must not be delivered'};} });
  assert.equal(h.sent.length, count);
  assert.equal(Number((await h.pg.query<{count:string}>('select count(*)::text count from messages')).rows[0]!.count),storedBefore+1,'paused inbound is retained');
  assert.equal((await h.pg.query<{routed_agent:string}>('select c.routed_agent from conversations c join clients cl on cl.id=c.client_id where cl.whatsapp_jid=$1',['55555555@lid'])).rows[0]!.routed_agent,'SALE','paused inbound is classified');
});

test('observeOwnerOutgoing guard #1 is idempotent on a re-delivered waha_msg_id', async () => {
  const h = await pgHarness();
  await seedEscalation(h, { created_at: '2026-09-08T10:00:00Z' });
  await enqueueMessage(h.db,h.tenant,h.provider,{session:'session',chatId:customer,text:'Pending bot reply'},
    {kind:'reply',notBefore:new Date(Date.now()+60_000),waitForDelivery:false});
  const body = { event: 'message', payload: { id: 'manual-7', from: '972500000009@c.us', to: customer, fromMe: true, source: 'app', body: 'Ответ владельца', _data: { Info: { IsFromMe: true, Chat: customer } } } };
  assert.equal(await observeOwnerOutgoing(h.db, h.tenant, body, new Date('2026-09-08T20:00:00Z')), true);
  assert.equal((await h.pg.query<{status:string}>("select status from outbound_messages where text='Pending bot reply'")).rows[0]!.status,'cancelled');
  const rows = Number((await h.pg.query<{ count: string }>('select count(*)::text as count from messages')).rows[0]!.count);
  await h.pg.query('update conversations set bot_paused=false where id=$1', [h.conversationId]);
  assert.equal(await observeOwnerOutgoing(h.db, h.tenant, body, new Date('2026-09-08T20:05:00Z')), false);
  assert.equal(Number((await h.pg.query<{ count: string }>('select count(*)::text as count from messages')).rows[0]!.count), rows, 'no duplicate stored message');
  assert.equal((await h.conversation()).bot_paused, false, 'no repeated pause/close side effects');
});

test('returning contact with assistant_introduced_at gets no repeated greeting', async () => {
  const { handleWebhookEvent } = await import('../workers/webhook.worker.js');
  const intro = 'Я ассистент владельца. Открыто с 9 до 18.';
  const ai = { async generateReply(i: { systemPrompt: string }) { return { text: i.systemPrompt.includes('классификатор намерений') ? '{"agent":"SALE","confidence":0.9}' : intro }; } };
  const run = async (introduced: boolean) => {
    const h = await pgHarness();
    await h.pg.query("insert into knowledge_items(tenant_id,type,question,answer,active) values($1,'faq','Есть ли доставка в Хайфу?','Да, доставка есть.',true)", [h.tenant]);
    await h.pg.query('update conversations set assistant_introduced_at=$2 where id=$1', [h.conversationId, introduced ? '2026-09-01T00:00:00Z' : null]);
    const body = { event: 'message', payload: { from: customer, fromMe: false, hasMedia: false, body: 'Сколько стоит доставка?', author: null, replyTo: null, _data: { Info: { Chat: customer, PushName: 'Клиент' } } } };
    await handleWebhookEvent(h.tenant, body, h.db, h.provider, ai as never);
    return h.sent.at(-1)?.text;
  };
  assert.equal(await run(true), 'Открыто с 9 до 18.');
  assert.equal(await run(false), intro);
});

test('assistant formatting strips placeholders and defer detection does not reject substantive tomorrow answer', () => {
  assert.equal(clientText('Ответ <имя> без > скобок'), 'Ответ без скобок');
  assert.equal(clientText('Передаю в SUPPORT / SALE для уточнения'), 'Передаю в для уточнения');
  assert.equal(isDeferredAnswer('Завтра доставка с 9 до 18'), false);
  assert.equal(isDeferredAnswer('позже'), true);
});

test('owner can pause any dialogue without an escalation; foreign dialogue cannot be changed', async () => {
  const h = await pgHarness();
  // A second real tenant in the SAME database (not a second PGlite instance): the point of
  // this test is that owner-workflow scopes every write by tenant_id even when it's handed
  // someone else's real, valid tenant id — a separate database would make the "foreign"
  // lookup fail on the tenants FK instead of on the intended tenant_id predicate, and mask
  // the thing being tested.
  const otherTenant = (await h.db.from('tenants').insert({ name: 'Other', business_name: 'Other', phone: '972500000099', language: 'ru', tier: 'basic', status: 'active' }).select('id').single()).data as { id: string };
  await handleOwnerMessage(h.db, h.provider, h.tenant, 'session', owner, `Беру на себя ${h.conversationId}`, null, h.settings);
  assert.equal((await h.conversation()).bot_paused, true);
  await handleOwnerMessage(h.db, h.provider, otherTenant.id, 'session', owner, `Продолжить диалог ${h.conversationId}`, null, h.settings);
  assert.equal((await h.conversation()).bot_paused, true, 'a different tenant id cannot touch this conversation');
  await handleOwnerMessage(h.db, h.provider, h.tenant, 'session', owner, `Продолжить диалог ${h.conversationId}`, null, h.settings);
  assert.equal((await h.conversation()).bot_paused, false);
});

test('owner timezone changes quiet hours and client time converts across calendar days', async () => {
  const { waitingText } = await import('../utils/assistant-text.js');
  const { clientTimeZoneCommand } = await import('../utils/time-zone.js');
  const settings = { ...defaultsFor('t'), time_zone: 'America/New_York', quiet_hours_start: '20:00', quiet_hours_end: '09:00' };
  const now = new Date('2026-09-09T02:00:00Z');
  assert.equal(isWithinQuietHours(settings, now), true);
  const end = nextQuietHoursEnd(settings, now);
  assert.ok(end);
  assert.equal(end.toISOString(), '2026-09-09T13:00:00.000Z');
  const message = waitingText('Вопрос', { at: end, ownerZone: settings.time_zone, clientZone: 'Asia/Tokyo' });
  assert.match(message, /22:00/); assert.match(message, /ваше местное время/);
  assert.match(waitingText('Вопрос', { at: end, ownerZone: settings.time_zone }), /09:00.*время владельца/);
  assert.equal(clientTimeZoneCommand('Часовой пояс Europe/Berlin'), 'Europe/Berlin');
  assert.equal(clientTimeZoneCommand('Часовой пояс invented/Place'), null);
});

test('owner answer translation preserves original for learning and falls back safely', async () => {
  const { translateOwnerAnswer } = await import('./ai-fallback.service.js');
  let calls = 0;
  const ai = { async generateReply(input: { systemPrompt: string; userMessage: string }) { calls++; assert.equal(JSON.parse(input.userMessage).ownerAnswer, 'Доставка завтра'); return { text: 'Delivery is tomorrow.' }; } };
  assert.equal(await translateOwnerAnswer('en', 'Доставка завтра', ai), 'Delivery is tomorrow.');
  assert.equal(await translateOwnerAnswer('ru', 'Доставка завтра', ai), 'Доставка завтра'); assert.equal(calls, 1);
  assert.equal(await translateOwnerAnswer('en', 'Доставка завтра', null), 'Доставка завтра');
});

test('owner translation is opt-in: disabled makes zero model calls', async () => {
  for (const enabled of [false, true]) {
    const h = await pgHarness();
    const settings = { ...h.settings, translate_owner_answer: enabled };
    const input = { tenant_id: h.tenant, conversation_id: h.conversationId, client_chat_id: customer, client_name: 'Тестовый клиент', question: 'Можно завтра?', session: 'session', inbound_id: 'incoming' };
    await createEscalation(h.db, h.provider, input, settings);
    const e = await h.escalation((await h.pg.query<{ id: string }>('select id from escalations limit 1')).rows[0]!.id);
    let calls = 0;
    await handleOwnerMessage(h.db, h.provider, h.tenant, 'session', owner, 'Yes, available', e.owner_message_ids[0]!, settings, { async generateReply() { calls++; return { text: 'Да, доступно' }; } });
    assert.equal(calls, enabled ? 1 : 0);
    assert.match(h.sent.at(-2)!.text, enabled ? /Да, доступно/ : /Yes, available/);
  }
});

test('timeout reminder is once, quoted reply matches it, quiet hours do not count, closure follows delivery', async () => {
  const { runEscalationTimeouts } = await import('./owner-workflow.service.js');
  const h = await pgHarness();
  await h.pg.query('update notification_settings set quiet_hours_start=$2,quiet_hours_end=$3,behavior=$4 where tenant_id=$1', [h.tenant, '20:00:00', '09:00:00', JSON.stringify({ escalation_remind_minutes: 60, escalation_close_minutes: 120 })]);
  const escalationId = await seedEscalation(h);
  await h.pg.query("update escalations set status='pending',owner_message_ids=array['initial'],pending_since='2026-09-08T16:30:00Z' where id=$1", [escalationId]);
  await runEscalationTimeouts(h.db, () => h.provider, new Date('2026-09-09T06:29:00Z')); assert.equal(h.sent.length, 0);
  await runEscalationTimeouts(h.db, () => h.provider, new Date('2026-09-09T06:30:00Z')); assert.equal(h.sent.length, 1);
  assert.equal((await h.escalation(escalationId)).owner_message_ids.length, 2);
  await runEscalationTimeouts(h.db, () => h.provider, new Date('2026-09-09T06:40:00Z')); assert.equal(h.sent.length, 1);
  await runEscalationTimeouts(h.db, () => h.provider, new Date('2026-09-09T07:30:00Z')); assert.equal(h.sent.length, 2);
  assert.equal((await h.escalation(escalationId)).status, 'closed_unanswered');
  assert.match(h.sent[1]!.text, /свяжется/);
});

function wav() {
  const bytes = Buffer.alloc(44 + 32000); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(32000, 40); return bytes;
}
function voiceRouting(h: Awaited<ReturnType<typeof pgHarness>>) {
  return { tenant: { id: h.tenant, name: 'Business', phone: '972500000001', status: 'active', language: 'ru' }, instance: { tenant_id: h.tenant, session_name: 'session' } } as never;
}

test('voice runs full GOWS identity, quota, transcription, agent, FAQ pipeline and wipes buffer', async () => {
  const { handleVoiceUsage } = await import('./voice-usage.service.js');
  const h = await pgHarness();
  await h.pg.query("insert into knowledge_items(tenant_id,type,question,answer,active) values($1,'faq','Какая цена?','Цена 100',true)", [h.tenant]);
  const body = JSON.parse(readFileSync('src/services/fixtures/gows-incoming-lid.json', 'utf8'));
  body.payload.from = customer; body.payload._data.Info.Chat = customer; body.payload.body = null; body.payload.hasMedia = true; body.payload.media = { mimetype: 'audio/wav', url: 'http://internal/api/files/session/id.wav' };
  const bytes = wav(); let calls = 0;
  await handleVoiceUsage(h.db, voiceRouting(h), body, h.provider, { async transcribe() { calls++; return { text: 'Какая цена?', confidence: 0.99, ambiguous: false, language: 'ru' }; } }, { async download() { return bytes; } });
  assert.equal(calls, 1); assert.equal(await h.admissions(), 1); assert.equal(h.sent.at(-1)?.text, 'Цена 100'); assert.ok(bytes.every(b => b === 0));
  for (const type of ['message_received', 'message_sent', 'stt_call', 'voice_received']) {
    const rows = (await h.pg.query<{ agent: string }>('select agent from usage_events where tenant_id=$1 and event_type=$2', [h.tenant, type])).rows;
    assert.ok(rows.length, `expected at least one ${type} event`);
    assert.ok(rows.every(r => typeof r.agent === 'string' && r.agent.length > 0));
  }
  const message = (await h.pg.query<{ body: string; raw_payload: { payload: { media: unknown } } }>('select body,raw_payload from messages limit 1')).rows[0]!;
  assert.equal(message.body, 'Какая цена?'); assert.equal(message.raw_payload.payload.media, null);
});

test('voice pause and quota stop STT; uncertainty asks for clarification without FAQ', async () => {
  const { handleVoiceUsage } = await import('./voice-usage.service.js');
  for (const mode of ['paused', 'denied', 'uncertain', 'disabled']) {
    const h = await pgHarness();
    if (mode === 'paused') await h.pg.query('update conversations set bot_paused=true where id=$1', [h.conversationId]);
    if (mode === 'denied') await h.deny();
    let calls = 0, downloads = 0;
    const body = JSON.parse(readFileSync('src/services/fixtures/gows-incoming-lid.json', 'utf8'));
    body.payload.from = customer; body.payload._data.Info.Chat = customer; body.payload.body = null; body.payload.hasMedia = true; body.payload.media = { mimetype: 'audio/wav', url: 'http://internal/api/files/session/id.wav' };
    await handleVoiceUsage(h.db, voiceRouting(h), body, h.provider, mode === 'disabled' ? null : { async transcribe() { calls++; return { text: 'Неясно завтра', confidence: 0.4, ambiguous: true, language: 'ru' }; } }, { async download() { downloads++; return wav(); } });
    assert.equal(calls, mode === 'uncertain' ? 1 : 0);
    if (mode === 'paused') {
      assert.equal(downloads, 0); assert.equal(await h.admissions(), 0); assert.equal(h.sent.length, 0);
      assert.equal(Number((await h.pg.query<{count:string}>("select count(*)::text count from messages where msg_type='voice'")).rows[0]!.count),1);
      const first = (await h.pg.query<{ event_type: string }>('select event_type from usage_events limit 1')).rows[0];
      assert.equal(first?.event_type, 'message_observed');
    } else {
      assert.match(h.sent.at(-1)!.text, mode === 'uncertain' ? /уточните/ : mode === 'denied' ? /недоступны/ : /не удалось распознать/);
    }
  }
});

test('voice opt-out exits before download, STT, admission or client response', async () => {
  const { handleVoiceUsage } = await import('./voice-usage.service.js');
  const h = await pgHarness();
  await h.pg.query('update clients set auto_reply_allowed=false where id=$1', [h.clientId]);
  const body = JSON.parse(readFileSync('src/services/fixtures/gows-incoming-lid.json', 'utf8'));
  body.payload.from = customer; body.payload._data.Info.Chat = customer; body.payload.body = null; body.payload.hasMedia = true; body.payload.media = { mimetype: 'audio/wav', url: 'http://internal/api/files/session/id.wav' };
  let transcriptions = 0, downloads = 0;
  await handleVoiceUsage(h.db, voiceRouting(h), body, h.provider, { async transcribe() { transcriptions++; return { text: 'Текст', confidence: 1, ambiguous: false, language: 'ru' }; } }, { async download() { downloads++; return wav(); } });
  assert.equal(downloads, 0); assert.equal(transcriptions, 0); assert.equal(await h.admissions(), 0); assert.equal(h.sent.length, 0);
  const first = (await h.pg.query<{ metadata: { reason: string } }>('select metadata from usage_events limit 1')).rows[0]!;
  assert.equal(first.metadata.reason, 'client_opt_out');
});
