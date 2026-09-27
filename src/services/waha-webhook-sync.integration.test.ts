import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionStatus, WhatsAppSessionProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { createTestDatabase, pgliteDatabaseClient } from './test-support/pglite-harness.js';
import { WahaAdminService } from './waha-admin.service.js';
import { sessionNameForTenant } from './waha-admin.utils.js';

async function fixture(sessions: Record<string, { status: string[]; events: string[] | null; token?: string; host?: string }>, publicBaseUrl = 'https://leya.example') {
  const pg = await createTestDatabase();
  const db = pgliteDatabaseClient(pg);
  const tenants: string[] = [];
  for (const name of Object.keys(sessions)) {
    const id = ((await db.from('tenants').insert({ name, business_name: name, language: 'ru', tier: 'basic', status: 'active' }).select('id').single()).data as { id: string }).id;
    await pg.query("insert into whatsapp_instances(tenant_id,waha_url,session_name,status) values($1,'http://waha',$2,'WORKING')", [id, sessionNameForTenant(id)]);
    tenants.push(id);
  }
  const byTenant = Object.fromEntries(Object.values(sessions).map((value, i) => [sessionNameForTenant(tenants[i]!), value]));
  const puts: Array<{ session: string; config: Record<string, unknown> }> = [];
  const polls: string[] = [];
  const provider = {
    async getSessionStatus(session: string): Promise<SessionStatus> {
      const s = byTenant[session]!;
      // Before the PUT the session reports status[0]; after it, the remaining statuses in order (last one sticks).
      if (!puts.some(p => p.session === session)) return { status: s.status[0]! };
      const current = s.status[s.status.length > 1 ? 1 : 0]!;
      if (s.status.length > 2) s.status.splice(1, 1);
      polls.push(current);
      return { status: current };
    },
    async getSessionConfig(session: string) {
      const s = byTenant[session]!; if (!s.events) return null;
      const tenantId = tenants[Object.keys(byTenant).indexOf(session)]!;
      return { markOnline: false, metadata: { tenant_id: tenantId }, proxy: null,
        webhooks: [{ url: `${s.host ?? 'https://leya.example'}/webhook/${tenantId}`, events: s.events, hmac: null,
          retries: { policy: 'linear', delaySeconds: 2, attempts: 4 },
          customHeaders: s.token === '' ? [] : [{ name: 'X-Webhook-Token', value: s.token ?? 'secret-token' }] },
          { url: 'https://other.example/hook', events: ['message'] }] };
    },
    async updateSessionConfig(session: string, config: Record<string, unknown>) { puts.push({ session, config }); },
  } as unknown as WhatsAppSessionProvider;
  const service = new WahaAdminService(db, provider, publicBaseUrl, 'http://waha');
  return { pg, db, tenants, puts, polls, service };
}

test('old subscription is updated with only events changed, then waits for WORKING; current one is left alone', async () => {
  const f = await fixture({ old: { status: ['WORKING', 'STARTING', 'WORKING'], events: ['message', 'session.status'] }, current: { status: ['WORKING'], events: ['message.any', 'session.status'] } });
  try {
    const started = Date.now();
    const results = await f.service.syncAllWebhookEvents(undefined, { pauseMs: 20, waitMs: 1_000, pollMs: 1 });
    assert.ok(Date.now() - started >= 20, 'pause between sessions');
    assert.deepEqual(results.map(r => [r.result, r.before, r.after, r.status]), [
      ['updated', ['message', 'session.status'], ['message.any', 'session.status'], 'WORKING'],
      ['unchanged', ['message.any', 'session.status'], ['message.any', 'session.status'], 'WORKING'],
    ]);
    assert.equal(f.puts.length, 1);
    assert.deepEqual(f.polls.slice(0, 2), ['STARTING', 'WORKING'], 'waited through the restart');
    const hook = (f.puts[0]!.config.webhooks as Array<Record<string, unknown>>)[0]!;
    assert.deepEqual(hook, { url: `https://leya.example/webhook/${f.tenants[0]}`, events: ['message.any', 'session.status'], hmac: null,
      retries: { policy: 'linear', delaySeconds: 2, attempts: 4 }, customHeaders: [{ name: 'X-Webhook-Token', value: 'secret-token' }] });
    assert.deepEqual(f.puts[0]!.config.metadata, { tenant_id: f.tenants[0] });
    assert.equal(f.puts[0]!.config.markOnline, false);
  } finally { await f.pg.close(); }
});

test('sessions waiting for a QR, failed, missing or without a token are never PUT', async () => {
  const f = await fixture({ qr: { status: ['SCAN_QR_CODE'], events: ['message', 'session.status'] }, failed: { status: ['FAILED'], events: ['message'] },
    missing: { status: ['WORKING'], events: null }, tokenless: { status: ['WORKING'], events: ['message'], token: '' } });
  try {
    const results = await f.service.syncAllWebhookEvents(undefined, { pauseMs: 0, waitMs: 100, pollMs: 1 });
    assert.deepEqual(results.map(r => r.result), ['requires_reconnect', 'requires_reconnect', 'requires_reconnect', 'failed']);
    assert.equal(f.puts.length, 0);
    const one = await f.service.syncAllWebhookEvents(f.tenants[0], { pauseMs: 0 });
    assert.equal(one.length, 1); assert.equal(one[0]!.tenantId, f.tenants[0]);
  } finally { await f.pg.close(); }
});

test('a restart that falls back to a QR is reported as requires_reconnect', async () => {
  const f = await fixture({ lost: { status: ['WORKING', 'STARTING', 'SCAN_QR_CODE'], events: ['message', 'session.status'] } });
  try {
    const [result] = await f.service.syncAllWebhookEvents(undefined, { pauseMs: 0, waitMs: 1_000, pollMs: 1 });
    assert.equal(result!.result, 'requires_reconnect'); assert.equal(result!.status, 'SCAN_QR_CODE');
  } finally { await f.pg.close(); }
});

const EVENTS = ['message.any', 'session.status'];

test('webhook on the old domain moves to PUBLIC_BASE_URL in one PUT, keeping token, retries, hmac and other webhooks', async () => {
  const f = await fixture({ old: { status: ['WORKING', 'WORKING'], events: EVENTS, host: 'https://leya.bizgenie.site' } }, 'https://api.bizgenie.site/');
  try {
    const [result] = await f.service.syncAllWebhookEvents(undefined, { pauseMs: 0, waitMs: 1_000, pollMs: 1 });
    const target = `https://api.bizgenie.site/webhook/${f.tenants[0]}`;
    assert.equal(result!.result, 'updated');
    assert.equal(result!.url_before, `https://leya.bizgenie.site/webhook/${f.tenants[0]}`);
    assert.equal(result!.url_after, target);
    assert.equal(f.puts.length, 1);
    const hooks = f.puts[0]!.config.webhooks as Array<Record<string, unknown>>;
    assert.deepEqual(hooks[0], { url: target, events: EVENTS, hmac: null,
      retries: { policy: 'linear', delaySeconds: 2, attempts: 4 }, customHeaders: [{ name: 'X-Webhook-Token', value: 'secret-token' }] });
    assert.deepEqual(hooks[1], { url: 'https://other.example/hook', events: ['message'] });
    assert.ok(!JSON.stringify(result).includes('secret-token'), 'result never carries the token');
  } finally { await f.pg.close(); }
});

test('matching URL and events is unchanged without a PUT; a tokenless webhook on the old domain is never written', async () => {
  const f = await fixture({ current: { status: ['WORKING'], events: EVENTS, host: 'https://api.bizgenie.site' },
    tokenless: { status: ['WORKING'], events: EVENTS, host: 'https://leya.bizgenie.site', token: '' } }, 'https://api.bizgenie.site');
  try {
    const results = await f.service.syncAllWebhookEvents(undefined, { pauseMs: 0 });
    assert.deepEqual(results.map(r => r.result), ['unchanged', 'failed']);
    assert.equal(results[1]!.url_after, results[1]!.url_before);
    assert.equal(f.puts.length, 0);
  } finally { await f.pg.close(); }
});

test('dryRun reports url_before/url_after and the new events without any PUT', async () => {
  const f = await fixture({ a: { status: ['WORKING'], events: ['message'], host: 'https://leya.bizgenie.site' },
    b: { status: ['WORKING'], events: EVENTS, host: 'https://api.bizgenie.site' } }, 'https://api.bizgenie.site');
  try {
    const results = await f.service.syncAllWebhookEvents(undefined, { dryRun: true });
    assert.deepEqual(results.map(r => [r.result, r.dryRun ?? false, r.url_before?.split('/webhook/')[0], r.url_after?.split('/webhook/')[0], r.after]), [
      ['updated', true, 'https://leya.bizgenie.site', 'https://api.bizgenie.site', EVENTS],
      ['unchanged', false, 'https://api.bizgenie.site', 'https://api.bizgenie.site', EVENTS],
    ]);
    assert.equal(f.puts.length, 0);
  } finally { await f.pg.close(); }
});

test('empty or non-https PUBLIC_BASE_URL is an error before anything is read or written', async () => {
  for (const base of ['', 'http://api.bizgenie.site', 'not a url']) {
    const f = await fixture({ a: { status: ['WORKING'], events: ['message'] } }, base);
    try {
      await assert.rejects(f.service.syncAllWebhookEvents(undefined, { pauseMs: 0 }), /public_base_url_invalid/);
      await assert.rejects(f.service.syncWebhookEvents(f.tenants[0]!), /public_base_url_invalid/);
      assert.equal(f.puts.length, 0);
    } finally { await f.pg.close(); }
  }
});

