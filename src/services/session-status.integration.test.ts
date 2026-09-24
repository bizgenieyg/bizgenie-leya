import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, pgliteDatabaseClient } from './test-support/pglite-harness.js';
import { updateSessionStatus } from './session-status.service.js';
import { WahaMonitor } from '../workers/waha-monitor.js';

async function fixture(status: string, lastAlert: string | null) {
  const pg = await createTestDatabase();
  const db = pgliteDatabaseClient(pg);
  const tenant = (await db.from('tenants').insert({ name: 'Shop', business_name: 'Shop +972 50 123 4567', language: 'ru', tier: 'basic', status: 'active' }).select('id').single()).data as { id: string };
  await pg.query('insert into whatsapp_instances(tenant_id,waha_url,session_name,status,last_session_alert) values($1,$2,$3,$4,$5)', [tenant.id, 'http://localhost', 'shop', status, lastAlert]);
  const alerts: Array<{ kind: string; text: string }> = [];
  const alert = async (kind: string, text: string) => { alerts.push({ kind, text }); return true; };
  return { pg, db, tenantId: tenant.id, alerts, alert };
}

test('WORKING → STARTING → FAILED alerts once; repeated status is silent; phone digits never leak', async () => {
  const f = await fixture('WORKING', 'session_recovered');
  try {
    for (const status of ['STARTING', 'FAILED', 'FAILED', 'SCAN_QR_CODE']) await updateSessionStatus(f.db, f.tenantId, status, f.alert);
    assert.deepEqual(f.alerts.map(a => a.kind), ['session_down']);
    assert.equal(f.alerts[0]!.text.includes('972 50 123 4567'), false);
  } finally { await f.pg.close(); }
});

test('FAILED → STARTING → WORKING sends recovered once', async () => {
  const f = await fixture('FAILED', 'session_down');
  try {
    for (const status of ['STARTING', 'WORKING', 'WORKING']) await updateSessionStatus(f.db, f.tenantId, status, f.alert);
    assert.deepEqual(f.alerts.map(a => a.kind), ['session_recovered']);
  } finally { await f.pg.close(); }
});

test('onboarding session that never worked raises no disconnect alert; first WORKING is silent', async () => {
  const f = await fixture('NOT_CREATED', null);
  try {
    for (const status of ['SCAN_QR_CODE', 'WORKING']) await updateSessionStatus(f.db, f.tenantId, status, f.alert);
    assert.equal(f.alerts.length, 0);
    await updateSessionStatus(f.db, f.tenantId, 'FAILED', f.alert);
    assert.deepEqual(f.alerts.map(a => a.kind), ['session_down']);
  } finally { await f.pg.close(); }
});

test('restart between status write and alert: state from DB catches up, monitor included', async () => {
  // Simulates a crash after the status write but before the alert: status already FAILED, alert state still "recovered".
  const f = await fixture('FAILED', 'session_recovered');
  try {
    const monitor = new WahaMonitor(f.db, async () => [{ name: 'shop', status: 'FAILED' }]);
    await updateSessionStatus(f.db, f.tenantId, 'FAILED', f.alert);
    assert.deepEqual(f.alerts.map(a => a.kind), ['session_down']);
    await monitor.check();
    const row = await f.pg.query<{ last_session_alert: string }>('select last_session_alert from whatsapp_instances where tenant_id=$1', [f.tenantId]);
    assert.equal(row.rows[0]!.last_session_alert, 'session_down');
    // A fresh process sees STARTING then WORKING and still recovers exactly once.
    await updateSessionStatus(f.db, f.tenantId, 'STARTING', f.alert);
    await updateSessionStatus(f.db, f.tenantId, 'WORKING', f.alert);
    assert.deepEqual(f.alerts.map(a => a.kind), ['session_down', 'session_recovered']);
  } finally { await f.pg.close(); }
});
