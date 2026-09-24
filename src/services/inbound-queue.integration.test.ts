import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, pgliteDatabaseClient } from './test-support/pglite-harness.js';
import { enqueueInbound, InboundProcessor, type InboundRow } from '../workers/inbound-queue.js';
import { loadOwnerSettings } from './owner-settings.service.js';
import { behavior, saveRuntimeSettings } from './runtime-settings.service.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const envelope = (id: string, from = '972500000001@c.us') => ({ event: 'message', payload: {
  id, from, fromMe: false, hasMedia: false, body: id, _data: { Info: { Chat: from, IsFromMe: false }, Message: { conversation: id } },
} });

async function harness() {
  const pg = await createTestDatabase();
  const db = pgliteDatabaseClient(pg);
  const tenant = (await db.from('tenants').insert({ name: 'Business', business_name: 'Business', phone: '972500000009', status: 'active' }).select('id').single()).data as { id: string };
  return { pg, db, tenantId: tenant.id };
}

test('durable inbound deduplicates WAHA retries and recovers after a restart', async () => {
  const h = await harness();
  assert.equal(await enqueueInbound(h.db, h.tenantId, envelope('one'), 0), true);
  assert.equal(await enqueueInbound(h.db, h.tenantId, envelope('one'), 0), false);
  const calls: string[][] = [];
  const worker = new InboundProcessor(h.db, async (_db, rows) => { calls.push(rows.map(row => row.waha_event_id)); });
  await worker.start();
  await delay(40);
  assert.deepEqual(calls, [['one']]);
  worker.stop();
  const rows = await h.pg.query<{ status: string }>('select status from inbound_events');
  assert.equal(rows.rows[0]!.status, 'done');
});

test('three messages in one quiet window form one ordered batch; different chats run in parallel', async () => {
  const h = await harness();
  const batches: InboundRow[][] = [];
  let active = 0, maxActive = 0;
  let release!: () => void;
  const overlap = new Promise<void>(resolve => { release = resolve; });
  const worker = new InboundProcessor(h.db, async (_db, rows) => {
    active++; maxActive = Math.max(maxActive, active); batches.push(rows);
    if (active === 2) release();
    await Promise.race([overlap, delay(1_500)]);
    active--;
  });
  await worker.start();
  await enqueueInbound(h.db, h.tenantId, envelope('first'), 0.4);
  await delay(15);
  await enqueueInbound(h.db, h.tenantId, envelope('second'), 0.4);
  await delay(15);
  await enqueueInbound(h.db, h.tenantId, envelope('third'), 0.4);
  await enqueueInbound(h.db, h.tenantId, envelope('other', '972500000002@c.us'), 0.4);
  for (let i = 0; i < 120 && batches.length < 2; i++) await delay(25);
  assert.equal(batches.length, 2);
  assert.deepEqual(batches.find(batch => batch[0]?.chat_id === '972500000001@c.us')?.map(row => row.waha_event_id), ['first', 'second', 'third']);
  assert.equal(maxActive, 2);
  worker.stop();
});

test('a second event in the same chat waits for the first handler to finish', async () => {
  const h = await harness();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const seen: string[] = [];
  let active = 0, maxActive = 0;
  const worker = new InboundProcessor(h.db, async (_db, rows) => {
    active++; maxActive = Math.max(maxActive, active); seen.push(rows[0]!.waha_event_id);
    if (rows[0]!.waha_event_id === 'one') await gate;
    active--;
  });
  await worker.start();
  await enqueueInbound(h.db, h.tenantId, envelope('one'), 0);
  await delay(40);
  await enqueueInbound(h.db, h.tenantId, envelope('two'), 0);
  await delay(40);
  assert.deepEqual(seen, ['one']);
  release();
  await delay(80);
  assert.deepEqual(seen, ['one', 'two']);
  assert.equal(maxActive, 1);
  worker.stop();
});

test('inbound payload table is inaccessible to anon and authenticated roles', async () => {
  const h = await harness();
  for (const role of ['anon', 'authenticated']) {
    await h.pg.exec(`set role ${role}`);
    await assert.rejects(h.pg.query('select * from public.inbound_events'));
    await assert.rejects(h.pg.query("insert into public.inbound_events(tenant_id,waha_event_id,chat_id,kind,payload) values($1,'x','x','client','{}')", [h.tenantId]));
    await h.pg.exec('reset role');
  }
});

test('runtime settings save invalidates the warm owner-settings cache', async () => {
  const h = await harness();
  await h.pg.query("insert into notification_settings(tenant_id,mode,time_zone) values($1,'mute_all','Asia/Jerusalem')", [h.tenantId]);
  await h.pg.query("insert into plans(code,display_name,messages_per_month,voice_minutes_per_month,warning_percent,unlimited) values('basic','Basic',500,60,80,false) on conflict(code) do nothing");
  await h.pg.query("insert into tenant_usage_limits(tenant_id,plan,messages_per_month,voice_minutes_per_month,warning_percent,messages_overridden,voice_overridden,warning_overridden) values($1,'basic',500,60,80,false,false,false)", [h.tenantId]);
  assert.equal(behavior(await loadOwnerSettings(h.db, h.tenantId)).inbound_quiet_seconds, 6);
  await saveRuntimeSettings(h.db, h.tenantId, { inbound_quiet_seconds: 4 });
  assert.equal(behavior(await loadOwnerSettings(h.db, h.tenantId)).inbound_quiet_seconds, 4);
});
