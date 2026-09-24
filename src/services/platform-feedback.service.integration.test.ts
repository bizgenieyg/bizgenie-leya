import assert from 'node:assert/strict';
import test from 'node:test';
import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { createTestDatabase, pgliteDatabaseClient } from './test-support/pglite-harness.js';
import { submitPlatformFeedback } from './platform-feedback.service.js';
import { stopOutboundQueue } from '../workers/outbound-queue.js';

async function fixture() {
  const pg = await createTestDatabase();
  const db = pgliteDatabaseClient(pg);
  const tenant = (await db.from('tenants').insert({ name: 'Studio', business_name: 'Studio', phone: '972500000009', status: 'active' }).select('id').single()).data as { id: string };
  await pg.query("insert into whatsapp_instances(tenant_id,waha_url,session_name,status) values($1,'http://localhost','tenant-session','WORKING')", [tenant.id]);
  await pg.query("insert into notification_settings(tenant_id,mode,time_zone,behavior) values($1,'mute_all','Asia/Jerusalem','{\"outbound_retry_delays_seconds\":[0,0,0]}'::jsonb)", [tenant.id]);
  return { pg, db, tenantId: tenant.id };
}

test('feedback is persisted before its WhatsApp notification enters the outbound queue', async () => {
  const h = await fixture();
  try {
    const calls: string[] = [];
    const provider: WhatsAppProvider = {
      async getSessionStatus() { return { status: 'WORKING' }; },
      async sendMessage(input) {
        calls.push(input.text);
        return { id: 'feedback-sent' };
      },
    };
    assert.deepEqual(await submitPlatformFeedback(h.tenantId, 'Очень удобно', h.db, provider, '972500000001@c.us'), { saved: true });
    assert.equal(calls.length, 1);
    const feedback = await h.pg.query<{ count: string }>('select count(*)::text count from platform_feedback where tenant_id=$1', [h.tenantId]);
    assert.equal(feedback.rows[0]!.count, '1');
    const sent = await h.pg.query<{ status: string }>('select status from outbound_messages where tenant_id=$1', [h.tenantId]);
    assert.equal(sent.rows[0]!.status, 'sent');
  } finally { await stopOutboundQueue(h.db); await h.pg.close(); }
});

test('notification failure does not lose saved feedback', async () => {
  const h = await fixture();
  try {
    let attempts = 0;
    const provider: WhatsAppProvider = { async getSessionStatus() { return { status: 'WORKING' }; },
      async sendMessage() { attempts++; throw new Error('offline'); } };
    const originalError = console.error; console.error = () => {};
    try { assert.deepEqual(await submitPlatformFeedback(h.tenantId, 'Saved', h.db, provider, '972500000001@c.us'), { saved: true }); }
    finally { console.error = originalError; }
    const saved = await h.pg.query<{ count: string }>('select count(*)::text count from platform_feedback where tenant_id=$1', [h.tenantId]);
    assert.equal(saved.rows[0]!.count, '1');
    assert.equal(attempts, 4, 'one initial attempt plus three retries');
    assert.equal((await h.pg.query<{status:string}>("select status from outbound_messages where kind='owner_notice'")).rows[0]!.status,'failed');
  } finally { await stopOutboundQueue(h.db); await h.pg.close(); }
});
