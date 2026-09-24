import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionStatusFromWebhook, updateSessionStatus } from './session-status.service.js';
import type { DatabaseClient } from '../db/supabase.js';

test('WAHA session status webhook is recognized, message events are not', () => {
  assert.equal(sessionStatusFromWebhook({ event: 'session.status', payload: { status: 'SCAN_QR_CODE' } }), 'SCAN_QR_CODE');
  assert.equal(sessionStatusFromWebhook({ event: 'session.status', payload: { status: 'WORKING' } }), 'WORKING');
  assert.equal(sessionStatusFromWebhook({ event: 'message', payload: { status: 'FAILED' } }), null);
});

test('WORKING → QR alerts once, repeated status is silent, recovery alerts once', async () => {
  const row = { status: 'WORKING' };
  const alerts: Array<{ kind: string; text: string }> = [];
  const db = { from(table: string) {
    let patch: { status?: string } | undefined;
    return { select() { return this; }, eq() { return this; }, update(values: { status: string }) { patch = values; return this; },
      async maybeSingle() {
        if (table === 'tenants') return { data: { business_name: 'Shop +972 50 123 4567' }, error: null };
        if (patch) Object.assign(row, patch);
        return { data: { ...row }, error: null };
      } };
  } } as unknown as DatabaseClient;
  const alert = async (kind: string, text: string) => { alerts.push({ kind, text }); return true; };
  await updateSessionStatus(db, 'tenant-1', 'SCAN_QR_CODE', alert);
  await updateSessionStatus(db, 'tenant-1', 'SCAN_QR_CODE', alert);
  await updateSessionStatus(db, 'tenant-1', 'WORKING', alert);
  assert.deepEqual(alerts.map(a => a.kind), ['session_down', 'session_recovered']);
  assert.equal(alerts[0]!.text.includes('972 50 123 4567'), false);
});
