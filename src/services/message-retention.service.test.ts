import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseClient } from '../db/supabase.js';
import { purgeExpiredMessages } from './message-retention.service.js';

function captureDb(deleted: string[]) {
  const call: { tenant?: unknown; cutoff?: string } = {};
  const db = {
    from() {
      const chain: Record<string, unknown> = {
        delete() { return chain; },
        eq(column: string, value: unknown) { if (column === 'tenant_id') call.tenant = value; return chain; },
        lt(column: string, value: string) { if (column === 'created_at') call.cutoff = value; return chain; },
        async select() { return { data: deleted.map(id => ({ id })), error: null }; },
      };
      return chain;
    },
  } as unknown as DatabaseClient;
  return { db, call };
}

test('purgeExpiredMessages deletes rows past the retention window for one tenant', async () => {
  const { db, call } = captureDb(['a', 'b', 'c']);
  const now = new Date('2026-09-09T00:00:00Z');
  const removed = await purgeExpiredMessages(db, 'tenant-1', 30, now);
  assert.equal(removed, 3);
  assert.equal(call.tenant, 'tenant-1');
  assert.equal(call.cutoff, '2026-08-10T00:00:00.000Z');
});

test('purgeExpiredMessages floors sub-minimum retention so history is never wiped', async () => {
  const { db, call } = captureDb([]);
  const now = new Date('2026-09-09T00:00:00Z');
  await purgeExpiredMessages(db, 'tenant-1', 1, now);
  // MESSAGE_RETENTION_MIN_DAYS = 7 → cutoff is 7 days back, not 1.
  assert.equal(call.cutoff, '2026-09-02T00:00:00.000Z');
});
