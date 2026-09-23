import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, pgliteDatabaseClient } from './test-support/pglite-harness.js';
import { ensureRetentionSweep, runEventJob } from '../workers/event-jobs.js';

test('one durable system retention job advances by a day without tenant polling', async () => {
  const pg = await createTestDatabase();
  const db = pgliteDatabaseClient(pg);
  const now = new Date('2026-09-23T10:00:00Z');
  await ensureRetentionSweep(db, now);
  await ensureRetentionSweep(db, now);
  const before = await pg.query<{ id: string; scheduled_at: string }>("select id,scheduled_at from scheduled_jobs where job_type='retention_sweep'");
  assert.equal(before.rows.length, 1);
  await pg.query("update scheduled_jobs set status='sending' where id=$1", [before.rows[0]!.id]);
  await runEventJob(db, { id: before.rows[0]!.id, tenant_id: null, job_type: 'retention_sweep', payload: {}, scheduled_at: now.toISOString(), status: 'sending' });
  const after = await pg.query<{ status: string; scheduled_at: string }>("select status,scheduled_at from scheduled_jobs where id=$1", [before.rows[0]!.id]);
  assert.equal(after.rows[0]!.status, 'pending');
  assert.ok(new Date(after.rows[0]!.scheduled_at).getTime() > Date.now() + 23 * 60 * 60_000);
});
