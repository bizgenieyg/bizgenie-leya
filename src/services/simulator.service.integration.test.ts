import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AIProvider } from '../providers/ai/ai-provider.interface.js';
import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { stopOutboundQueue } from '../workers/outbound-queue.js';
import { handleWebhookEvent } from '../workers/webhook.worker.js';
import { createTestDatabase, pgliteDatabaseClient } from './test-support/pglite-harness.js';
import { simulateCustomerMessage } from './simulator.service.js';
import { purgeExpiredSimulatorMessages } from './simulator-retention.service.js';

async function fixture() {
  const pg = await createTestDatabase();
  const db = pgliteDatabaseClient(pg);
  const tenant = await db.from('tenants').insert({ name: 'Даниэль', business_name: 'BizGenie', language: 'ru', tier: 'basic', status: 'active' }).select('id').single();
  assert.equal(tenant.error, null);
  const tenantId = (tenant.data as { id: string }).id;
  await pg.query("insert into notification_settings(tenant_id,mode,time_zone,auto_replies_paused,owner_phone,behavior) values($1,'mute_all','Asia/Jerusalem',false,'+972500000002',$2)",
    [tenantId, JSON.stringify({ enabled_agents: ['SALE', 'SUPPORT'], reception_max_messages: 0, simulator_hourly_limit: 30, simulator_daily_limit: 100 })]);
  await pg.query("insert into plans(code,display_name,messages_per_month,voice_minutes_per_month,warning_percent,unlimited) values('basic','Базовый',500,60,80,false) on conflict(code) do nothing");
  await pg.query("insert into tenant_usage_limits(tenant_id,plan,messages_per_month,voice_minutes_per_month,warning_percent,messages_overridden,voice_overridden,warning_overridden) values($1,'basic',500,60,80,false,false,false)", [tenantId]);
  await pg.query("insert into assistant_profiles(tenant_id,assistant_name,allowed_languages,tone) values($1,'Leya',array['ru'],'friendly_professional')", [tenantId]);
  const root = await mkdtemp(join(tmpdir(), 'leya-sim-'));
  return { pg, db, tenantId, root, async close() { await stopOutboundQueue(db); await pg.close(); await rm(root, { recursive: true, force: true }); } };
}

test('051 persists isolated simulator messages and keeps customer tables untouched', async () => {
  const f = await fixture();
  try {
    await f.pg.query("insert into knowledge_items(tenant_id,type,question,answer,active) values($1,'faq','Часы работы?','<b>С 9 до 18.</b>',true)", [f.tenantId]);
    const session = crypto.randomUUID();
    const ai: AIProvider = { async generateReply() { throw new Error('FAQ must not call AI'); } };
    const first = await simulateCustomerMessage(f.db, f.tenantId, session, 'Часы работы?', ai, { root: f.root });
    assert.deepEqual(first, { reply: 'С 9 до 18.', outcome: 'answered' });
    const rows = await f.pg.query<{ from_me: boolean; body: string }>('select from_me,body from simulator_messages where tenant_id=$1 and session_id=$2 order by sequence', [f.tenantId, session]);
    assert.equal(rows.rows.length, 2);
    assert.equal(rows.rows.find(row => row.from_me)?.body, '<b>С 9 до 18.</b>');
    for (const table of ['messages', 'conversations', 'clients', 'escalations']) {
      const count = await f.pg.query<{ n: number }>(`select count(*)::int n from ${table} where tenant_id=$1`, [f.tenantId]);
      assert.equal(count.rows[0]!.n, 0, table);
    }
    for (const role of ['anon', 'authenticated']) {
      await f.pg.exec(`set role ${role}`);
      await assert.rejects(f.pg.query('select * from simulator_messages'), /permission denied/);
      await assert.rejects(f.pg.query('select * from simulator_sessions'), /permission denied/);
      await f.pg.exec('reset role');
    }
  } finally { await f.close(); }
});

test('simulator preserves history after a service call and marks paused previews', async () => {
  const f = await fixture();
  try {
    await f.pg.query('update notification_settings set auto_replies_paused=true where tenant_id=$1', [f.tenantId]);
    const session = crypto.randomUUID();
    const prompts: string[] = [];
    const ai: AIProvider = { async generateReply(input) {
      if (input.systemPrompt.includes('классификатор')) return { text: '{"agent":"SALE","confidence":0.1}' };
      prompts.push(input.systemPrompt + input.userMessage);
      return { text: 'Ответ' };
    } };
    const first = await simulateCustomerMessage(f.db, f.tenantId, session, 'Первый вопрос', ai, { root: f.root });
    assert.equal(first.outcome, 'answered');
    assert.equal(first.pausedNote, true);
    const second = await simulateCustomerMessage(f.db, f.tenantId, session, 'Уточнение', ai, { root: f.root });
    assert.match(prompts.at(-1) ?? '', /Первый вопрос/);
    assert.match(prompts.at(-1) ?? '', /уже представлялся/);
    assert.equal(second.pausedNote, true);
  } finally { await f.close(); }
});

test('simulator message retention removes only expired rows for the chosen tenant', async () => {
  const f = await fixture();
  try {
    const session = crypto.randomUUID();
    await f.pg.query('insert into simulator_sessions(tenant_id,id) values($1,$2)', [f.tenantId, session]);
    await f.pg.query("insert into simulator_messages(tenant_id,session_id,from_me,body,created_at) values($1,$2,false,'old',$3),($1,$2,true,'new',$4)",
      [f.tenantId, session, '2026-09-20T00:00:00Z', '2026-09-23T00:00:00Z']);
    assert.equal(await purgeExpiredSimulatorMessages(f.db, f.tenantId, 48, new Date('2026-09-23T12:00:00Z')), 1);
    const remaining = await f.pg.query<{ body: string }>('select body from simulator_messages where tenant_id=$1', [f.tenantId]);
    assert.deepEqual(remaining.rows.map(row => row.body), ['new']);
  } finally { await f.close(); }
});

test('two-turn WhatsApp and simulator replies are byte-for-byte equivalent', async () => {
  const f = await fixture();
  try {
    const sent: string[] = [];
    const provider: WhatsAppProvider = {
      async sendMessage(input) { sent.push(input.text); return { id: `sent-${sent.length}` }; },
      async getSessionStatus() { return { status: 'WORKING' }; },
    };
    const ai: AIProvider = { async generateReply(input) {
      if (input.systemPrompt.includes('классификатор')) return { text: '{"agent":"SALE","confidence":0.1}' };
      return { text: 'Я ассистент владельца. Расскажите подробнее об услуге.' };
    } };
    const session = crypto.randomUUID();
    for (const text of ['Здравствуйте, помогите выбрать услугу', 'Мне нужна консультация']) {
      await handleWebhookEvent(f.tenantId, { event: 'message', payload: { from: '972500000001@c.us', fromMe: false,
        hasMedia: false, body: text, author: null, replyTo: null, _data: { Info: { PushName: 'Тест' } } } }, f.db, provider, ai);
      const simulation = await simulateCustomerMessage(f.db, f.tenantId, session, text, ai, { root: f.root });
      assert.equal(simulation.reply, sent.at(-1));
    }
    assert.doesNotMatch(sent[1] ?? '', /^Я ассистент владельца\./);
  } finally { await f.close(); }
});

test('pilot unlimited plan answers a FAQ identically in WhatsApp and simulator', async () => {
  const f = await fixture();
  try {
    await f.pg.query("update tenant_usage_limits set plan='pilot',messages_overridden=false where tenant_id=$1", [f.tenantId]);
    await f.pg.query("insert into knowledge_items(tenant_id,type,question,answer,active) values($1,'faq','Часы работы?','<b>С 9 до 18.</b>',true)", [f.tenantId]);
    const summary = await f.pg.query<{ usage: { unlimited: boolean; messages_limit: number | null } }>(
      'select tenant_usage_summary($1,0,0) as usage', [f.tenantId]);
    assert.equal(summary.rows[0]!.usage.unlimited, true);
    assert.equal(summary.rows[0]!.usage.messages_limit, 0);
    const sent: string[] = [];
    const provider: WhatsAppProvider = {
      async sendMessage(input) { sent.push(input.text); return { id: `sent-${sent.length}` }; },
      async getSessionStatus() { return { status: 'WORKING' }; },
    };
    const text = 'Часы работы?';
    await handleWebhookEvent(f.tenantId, { event: 'message', payload: { from: '972500000001@c.us', fromMe: false,
      hasMedia: false, body: text, author: null, replyTo: null, _data: { Info: { PushName: 'Тест' } } } }, f.db, provider, null);
    const simulation = await simulateCustomerMessage(f.db, f.tenantId, crypto.randomUUID(), text, null, { root: f.root });
    assert.equal(simulation.outcome, 'answered');
    assert.equal(simulation.reply, 'С 9 до 18.');
    assert.equal(simulation.reply, sent.at(-1));
  } finally { await f.close(); }
});

test('agent answer uses knowledge and records only simulated model usage', async () => {
  const f = await fixture();
  try {
    await f.pg.query("insert into knowledge_items(tenant_id,type,question,answer,active) values($1,'faq','Какие услуги?','Консультация.',true)", [f.tenantId]);
    const ai: AIProvider = { async generateReply(input) {
      return { text: input.systemPrompt.includes('классификатор') ? '{"agent":"SALE","confidence":0.99}' : 'Мы предлагаем консультацию.' };
    } };
    const result = await simulateCustomerMessage(f.db, f.tenantId, crypto.randomUUID(), 'Расскажите об услугах', ai, { root: f.root });
    assert.equal(result.outcome, 'answered');
    assert.equal(result.reply, 'Мы предлагаем консультацию.');
    const usage = await f.pg.query<{ metadata: { simulation?: boolean } }>('select metadata from usage_events where tenant_id=$1 and event_type=$2', [f.tenantId, 'model_call']);
    assert.ok(usage.rows.length > 0);
    assert.ok(usage.rows.every(row => row.metadata.simulation === true));
  } finally { await f.close(); }
});

test('reception ESCALATE_OWNER and missing knowledge return the client waiting text', async () => {
  const f = await fixture();
  try {
    const receptionAI: AIProvider = { async generateReply(input) {
      return { text: input.systemPrompt.includes('классификатор') ? '{"agent":"SALE","confidence":0.1}' : 'ESCALATE_OWNER' };
    } };
    const reception = await simulateCustomerMessage(f.db, f.tenantId, crypto.randomUUID(), 'Хочу поговорить с владельцем', receptionAI, { root: f.root });
    assert.equal(reception.outcome, 'escalated');
    assert.ok(reception.reply);
    assert.notEqual(reception.reply, 'ESCALATE_OWNER');
    const agentAI: AIProvider = { async generateReply() { return { text: '{"agent":"SALE","confidence":0.99}' }; } };
    const missing = await simulateCustomerMessage(f.db, f.tenantId, crypto.randomUUID(), 'Какая цена услуги?', agentAI, { root: f.root });
    assert.equal(missing.outcome, 'escalated');
    assert.equal(missing.reply, reception.reply);
  } finally { await f.close(); }
});

test('escalation preview matches the actual WhatsApp customer message', async () => {
  const f = await fixture();
  try {
    const customer = '972500000001@c.us';
    const sent: Array<{ chatId: string; text: string }> = [];
    const provider: WhatsAppProvider = {
      async sendMessage(input) { sent.push({ chatId: input.chatId, text: input.text }); return { id: `sent-${sent.length}` }; },
      async getSessionStatus() { return { status: 'WORKING', me: { id: '972500000003@c.us' } }; },
    };
    const ai: AIProvider = { async generateReply(input) {
      return { text: input.systemPrompt.includes('классификатор') ? '{"agent":"SALE","confidence":0.1}' : 'ESCALATE_OWNER' };
    } };
    const question = 'Мне нужен ответ владельца';
    await handleWebhookEvent(f.tenantId, { event: 'message', payload: { from: customer, fromMe: false,
      hasMedia: false, body: question, author: null, replyTo: null, _data: { Info: { PushName: 'Тест' } } } }, f.db, provider, ai);
    const simulation = await simulateCustomerMessage(f.db, f.tenantId, crypto.randomUUID(), question, ai, { root: f.root });
    assert.equal(simulation.outcome, 'escalated');
    assert.equal(simulation.reply, sent.find(message => message.chatId === customer)?.text);
  } finally { await f.close(); }
});

test('quiet hours and client timezone command use the live reply rules', async () => {
  const f = await fixture();
  try {
    await f.pg.query("update notification_settings set quiet_hours_start='22:00',quiet_hours_end='06:00' where tenant_id=$1", [f.tenantId]);
    const now = new Date('2026-09-23T21:00:00Z');
    const ai: AIProvider = { async generateReply(input) {
      return { text: input.systemPrompt.includes('классификатор') ? '{"agent":"SALE","confidence":0.1}' : 'ESCALATE_OWNER' };
    } };
    const quiet = await simulateCustomerMessage(f.db, f.tenantId, crypto.randomUUID(), 'Нужна помощь', ai, { root: f.root, now });
    assert.equal(quiet.outcome, 'escalated');
    assert.equal(quiet.quietHours?.active, true);
    assert.ok(quiet.quietHours?.until);
    const agentAI: AIProvider = { async generateReply() { return { text: '{"agent":"SALE","confidence":0.99}' }; } };
    const zone = await simulateCustomerMessage(f.db, f.tenantId, crypto.randomUUID(), 'часовой пояс UTC+3', agentAI, { root: f.root, now });
    assert.equal(zone.outcome, 'answered');
    assert.match(zone.reply ?? '', /UTC\+3/);
  } finally { await f.close(); }
});

test('exhausted customer quota is previewed without charging a simulator call to it', async () => {
  const f = await fixture();
  try {
    const before = await f.pg.query<{ n: number }>('select count(*)::int n from tenant_monthly_usage where tenant_id=$1', [f.tenantId]);
    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
    await f.pg.query("update tenant_usage_limits set messages_per_month=1,messages_overridden=true where tenant_id=$1", [f.tenantId]);
    await f.pg.query("insert into tenant_monthly_usage(tenant_id,month,time_zone,messages_used) values($1,$2,'Asia/Jerusalem',1)", [f.tenantId, month]);
    const result = await simulateCustomerMessage(f.db, f.tenantId, crypto.randomUUID(), 'Привет', null, { root: f.root, now });
    assert.equal(result.outcome, 'limit');
    assert.ok(result.reply);
    const sent: string[] = [];
    const provider: WhatsAppProvider = {
      async sendMessage(input) { sent.push(input.text); return { id: `sent-${sent.length}` }; },
      async getSessionStatus() { return { status: 'WORKING' }; },
    };
    await handleWebhookEvent(f.tenantId, { event: 'message', payload: { from: '972500000001@c.us', fromMe: false,
      hasMedia: false, body: 'Привет', author: null, replyTo: null, _data: { Info: { PushName: 'Тест' } } } }, f.db, provider, null);
    assert.equal(result.reply, sent.at(-1));
    const after = await f.pg.query<{ n: number; messages_used: number }>('select count(*)::int n,max(messages_used)::int messages_used from tenant_monthly_usage where tenant_id=$1', [f.tenantId]);
    assert.equal(after.rows[0]!.n, before.rows[0]!.n + 1);
    assert.equal(after.rows[0]!.messages_used, 1);
  } finally { await f.close(); }
});

test('simulator hourly and daily limits remain independent of customer quota', async () => {
  const f = await fixture();
  try {
    await f.pg.query("update notification_settings set behavior=behavior||'{\"simulator_hourly_limit\":1,\"simulator_daily_limit\":2}'::jsonb where tenant_id=$1", [f.tenantId]);
    await f.pg.query("insert into knowledge_items(tenant_id,type,question,answer,active) values($1,'faq','Время?','С 9 до 18.',true)", [f.tenantId]);
    const session = crypto.randomUUID();
    const run = (time: string) => simulateCustomerMessage(f.db, f.tenantId, session, 'Время?', null, { root: f.root, now: new Date(time) });
    await run('2026-09-23T10:00:00Z');
    await assert.rejects(run('2026-09-23T10:10:00Z'), /hourly/);
    await run('2026-09-23T11:00:00Z');
    await assert.rejects(run('2026-09-23T12:00:00Z'), /daily/);
    const usage = await f.pg.query<{ n: number }>('select count(*)::int n from tenant_monthly_usage where tenant_id=$1', [f.tenantId]);
    assert.equal(usage.rows[0]!.n, 0);
  } finally { await f.close(); }
});
