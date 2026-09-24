import assert from 'node:assert/strict';
import test from 'node:test';
import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { createTestDatabase, pgliteDatabaseClient } from './test-support/pglite-harness.js';
import { cancelPendingReplies, enqueueMessage, gapMs, OutboundProcessor, plannedNotBefore, stopOutboundQueue, typingDelayMs } from '../workers/outbound-queue.js';
import { BEHAVIOR_DEFAULTS } from '../config/behavior.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean, timeoutMs = 3_000) {
  const end = Date.now() + timeoutMs;
  while (!condition() && Date.now() < end) await delay(10);
  assert.ok(condition(), 'expected asynchronous queue state');
}
async function fixture() {
  const pg = await createTestDatabase();
  const db = pgliteDatabaseClient(pg);
  const tenant = (await db.from('tenants').insert({ name: 'Business', business_name: 'Business', phone: '972500000009', status: 'active' }).select('id').single()).data as { id: string };
  await pg.query("insert into notification_settings(tenant_id,owner_phone,owner_chat_id,mode,time_zone,behavior) values($1,'972500000008','972500000008@c.us','mute_all','Asia/Jerusalem','{\"outbound_typing_min_seconds\":0,\"outbound_typing_max_seconds\":0,\"outbound_conversation_gap_min_seconds\":0,\"outbound_conversation_gap_max_seconds\":0,\"outbound_retry_delays_seconds\":[0,0,0]}'::jsonb)", [tenant.id]);
  return { pg, db, tenantId: tenant.id, async close() { await stopOutboundQueue(db); await pg.close(); } };
}

test('five messages from one session are serial; another session can send concurrently', async () => {
  const h = await fixture();
  try {
    let active = 0, maxSame = 0;
    let parallelMode = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let concurrent = 0, maxConcurrent = 0;
    const sent: string[] = [];
    const provider: WhatsAppProvider = { async getSessionStatus() { return { status: 'WORKING' }; },
      async sendMessage(input) {
        if (parallelMode) { concurrent++; maxConcurrent = Math.max(concurrent, maxConcurrent); if (concurrent === 2) release(); await Promise.race([gate, delay(1_000)]); concurrent--; return { id: input.session }; }
        active++; maxSame = Math.max(maxSame, active); sent.push(input.text); await delay(15); active--; return { id: input.text };
      } };
    const calls = Array.from({ length: 5 }, (_, i) => enqueueMessage(h.db, h.tenantId, provider,
      { session: 'one', chatId: '972500000001@c.us', text: String(i) }, { kind: 'reply', dedupeKey: `one-${i}` }));
    await Promise.all(calls);
    assert.deepEqual(sent, ['0', '1', '2', '3', '4']);
    assert.equal(maxSame, 1);
    parallelMode = true;
    const pair = [enqueueMessage(h.db, h.tenantId, provider, { session: 'two', chatId: '972500000001@c.us', text: 'A' }),
      enqueueMessage(h.db, h.tenantId, provider, { session: 'three', chatId: '972500000001@c.us', text: 'B' })];
    await Promise.all(pair);
    assert.equal(maxConcurrent, 2);
  } finally { await h.close(); }
});

test('seen, typing, stop, text order survives typing failure', async () => {
  const h = await fixture();
  try {
    const events: string[] = [];
    const provider: WhatsAppProvider = { async getSessionStatus() { return { status: 'WORKING' }; },
      async sendSeen(input) { events.push(`seen:${input.messageIds?.join(',')}`); },
      async startTyping() { events.push('typing'); throw new Error('unsupported'); },
      async stopTyping() { events.push('stop'); },
      async sendMessage() { events.push('text'); return { id: 'sent' }; } };
    const error = console.error; console.error = () => {};
    try { await enqueueMessage(h.db, h.tenantId, provider, { session: 'one', chatId: '972500000001@c.us', text: 'Hello' },
      { kind: 'reply', inboundMessageIds: ['incoming'] }); }
    finally { console.error = error; }
    assert.deepEqual(events, ['seen:incoming', 'typing', 'stop', 'text']);
  } finally { await h.close(); }
});

test('expired reminder is not sent and creates an owner notice', async () => {
  const h = await fixture();
  try {
    const sent: string[] = [];
    const provider: WhatsAppProvider = { async getSessionStatus() { return { status: 'WORKING' }; },
      async sendMessage(input) { sent.push(input.text); return { id: `id-${sent.length}` }; } };
    await assert.rejects(enqueueMessage(h.db, h.tenantId, provider,
      { session: 'one', chatId: '972500000001@c.us', text: 'Late reminder' },
      { kind: 'reminder', deadlineAt: new Date(Date.now() - 1_000) }));
    await until(() => sent.length === 1);
    assert.doesNotMatch(sent[0]!, /Late reminder/);
    const row = await h.pg.query<{ status: string }>("select status from outbound_messages where kind='reminder'");
    assert.equal(row.rows[0]!.status, 'expired');
  } finally { await h.close(); }
});

test('restart recovers pending once; dedupe key and manual cancellation are durable', async () => {
  const h = await fixture();
  try {
    const sent: string[] = [];
    const provider: WhatsAppProvider = { async getSessionStatus() { return { status: 'WORKING' }; },
      async sendMessage(input) { sent.push(input.text); return { id: `id-${sent.length}` }; } };
    const future = new Date(Date.now() + 60_000);
    const first = await enqueueMessage(h.db, h.tenantId, provider,
      { session: 'one', chatId: '972500000001@c.us', text: 'Pending' },
      { kind: 'reply', dedupeKey: 'restart-1', notBefore: future, waitForDelivery: false });
    const duplicate = await enqueueMessage(h.db, h.tenantId, provider,
      { session: 'one', chatId: '972500000001@c.us', text: 'Pending' },
      { kind: 'reply', dedupeKey: 'restart-1', notBefore: future, waitForDelivery: false });
    assert.equal(first.id, duplicate.id);
    await stopOutboundQueue(h.db);
    await h.pg.query("update outbound_messages set not_before=now() where dedupe_key='restart-1'");
    const worker = new OutboundProcessor(h.db, provider);
    await worker.start();
    await until(() => sent.length === 1);
    worker.stop(); await worker.drain();
    assert.deepEqual(sent, ['Pending']);
    await enqueueMessage(h.db, h.tenantId, provider,
      { session: 'one', chatId: '972500000001@c.us', text: 'Cancel me' },
      { kind: 'reply', notBefore: future, waitForDelivery: false });
    await cancelPendingReplies(h.db, h.tenantId, '972500000001@c.us');
    const cancelled = await h.pg.query<{ status: string }>("select status from outbound_messages where text='Cancel me'");
    assert.equal(cancelled.rows[0]!.status, 'cancelled');
  } finally { await h.close(); }
});

test('typing, gaps and early-only reminder spread stay within configured bounds', () => {
  const settings = BEHAVIOR_DEFAULTS;
  assert.equal(typingDelayMs(1, settings, () => 0), 2_000);
  assert.equal(typingDelayMs(1_000, settings, () => 1), 8_000);
  assert.equal(gapMs('reply', settings, () => 0), 3_000);
  assert.equal(gapMs('reply', settings, () => 1), 10_000);
  assert.equal(gapMs('reminder', settings, () => 0), 25_000);
  assert.equal(gapMs('broadcast', settings, () => 1), 90_000);
  const created = new Date('2026-09-24T08:00:00Z'), sendAt = new Date('2026-09-24T08:10:00Z');
  assert.equal(plannedNotBefore(created, sendAt, 20, () => 1).toISOString(), '2026-09-24T08:05:00.000Z');
  assert.equal(plannedNotBefore(created, sendAt, 20, () => 0).toISOString(), sendAt.toISOString());
});

test('outbound message bodies are not readable by anon or authenticated roles', async () => {
  const h = await fixture();
  try {
    for (const role of ['anon', 'authenticated']) {
      await h.pg.exec(`set role ${role}`);
      await assert.rejects(h.pg.query('select text from outbound_messages'));
      await h.pg.exec('reset role');
    }
  } finally { await h.close(); }
});

test('a WAHA timeout is retried without leaving the queue stuck', async () => {
  const h = await fixture();
  try {
    let attempts = 0;
    const provider: WhatsAppProvider = { async getSessionStatus() { return { status: 'WORKING' }; },
      async sendMessage() { attempts++; if (attempts === 1) throw new DOMException('timed out', 'TimeoutError'); return { id: 'retry-sent' }; } };
    assert.deepEqual(await enqueueMessage(h.db,h.tenantId,provider,
      {session:'one',chatId:'972500000001@c.us',text:'Retry me'},{kind:'reply'}),{id:'retry-sent'});
    assert.equal(attempts,2);
    const row = await h.pg.query<{status:string;attempts:number}>("select status,attempts from outbound_messages where text='Retry me'");
    assert.equal(row.rows[0]!.status,'sent');
    assert.equal(row.rows[0]!.attempts,1);
  } finally { await h.close(); }
});

test('daily proactive ceiling defers broadcasts but never defers a deadline reminder', async () => {
  const h = await fixture();
  try {
    await h.pg.query("update notification_settings set behavior=behavior||'{\"daily_proactive_limit\":0}'::jsonb where tenant_id=$1", [h.tenantId]);
    const sent: string[] = [];
    const provider: WhatsAppProvider = { async getSessionStatus() { return { status: 'WORKING' }; },
      async sendMessage(input) { sent.push(input.text); return { id: `sent-${sent.length}` }; } };
    await enqueueMessage(h.db,h.tenantId,provider,{session:'one',chatId:'972500000001@c.us',text:'Broadcast'},
      {kind:'broadcast',waitForDelivery:false});
    await delay(100);
    assert.deepEqual(sent,[]);
    const broadcast = await h.pg.query<{ status: string; not_before: string }>("select status,not_before from outbound_messages where kind='broadcast'");
    assert.equal(broadcast.rows[0]!.status,'pending');
    assert.ok(Date.parse(broadcast.rows[0]!.not_before)>Date.now()+23*60*60_000);
    await enqueueMessage(h.db,h.tenantId,provider,{session:'one',chatId:'972500000001@c.us',text:'Reminder'},
      {kind:'reminder',deadlineAt:new Date(Date.now()+60_000)});
    assert.deepEqual(sent,['Reminder']);
  } finally { await h.close(); }
});

test('the same session selects priority before enqueue time', async () => {
  const h = await fixture();
  try {
    const sent: string[] = [];
    const provider: WhatsAppProvider = { async getSessionStatus() { return { status: 'WORKING' }; },
      async sendMessage(input) { sent.push(input.text); return { id: `sent-${sent.length}` }; } };
    const older = new Date(Date.now()-2_000).toISOString();
    const newer = new Date(Date.now()-1_000).toISOString();
    await h.pg.query("insert into outbound_messages(tenant_id,session,chat_id,text,kind,priority,not_before,dedupe_key) values($1,'one','972500000001@c.us','Summary','summary',2,$2,'summary'),($1,'one','972500000001@c.us','Reply','reply',0,$3,'reply')", [h.tenantId,older,newer]);
    const worker = new OutboundProcessor(h.db,provider);
    await worker.start();
    await until(() => sent.length === 2);
    worker.stop(); await worker.drain();
    assert.deepEqual(sent,['Reply','Summary']);
  } finally { await h.close(); }
});
