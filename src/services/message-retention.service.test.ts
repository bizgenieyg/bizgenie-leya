import assert from 'node:assert/strict';
import test from 'node:test';
import { purgeExpiredMessages } from './message-retention.service.js';
import { createTestDatabase, pgliteDatabaseClient } from './test-support/pglite-harness.js';

// Converted to PGlite (real migrations) per review: the previous mock never actually
// deleted anything (its `delete()` was a no-op returning canned ids), so it could not
// have caught a wrong column name, a missing tenant_id scope (cross-tenant deletion),
// or a `created_at` type mismatch. This asserts against the real `messages` table.

async function seedTenantWithMessages(createdAtOffsetsDays: number[]) {
  const pg = await createTestDatabase();
  const db = pgliteDatabaseClient(pg);
  const tenant = (await db.from('tenants').insert({ name: 'T', business_name: 'B', language: 'ru', tier: 'basic', status: 'active' }).select('id').single()).data as { id: string };
  const other = (await db.from('tenants').insert({ name: 'Other', business_name: 'O', language: 'ru', tier: 'basic', status: 'active' }).select('id').single()).data as { id: string };
  const conversation = (await db.from('conversations').insert({ tenant_id: tenant.id, status: 'active' }).select('id').single()).data as { id: string };
  const otherConversation = (await db.from('conversations').insert({ tenant_id: other.id, status: 'active' }).select('id').single()).data as { id: string };
  const now = new Date('2026-09-09T00:00:00Z');
  for (const days of createdAtOffsetsDays) {
    const createdAt = new Date(now.getTime() - days * 86400000).toISOString();
    await pg.query('insert into messages(tenant_id,conversation_id,from_me,body,created_at) values($1,$2,false,$3,$4)', [tenant.id, conversation.id, `msg-${days}d`, createdAt]);
  }
  // A message just as old belonging to a DIFFERENT tenant must survive any purge of `tenant.id`.
  await pg.query('insert into messages(tenant_id,conversation_id,from_me,body,created_at) values($1,$2,false,$3,$4)', [other.id, otherConversation.id, 'other tenant old message', new Date(now.getTime() - 90 * 86400000).toISOString()]);
  return { pg, db, tenantId: tenant.id, otherTenantId: other.id, now };
}

test('purgeExpiredMessages deletes rows past the retention window for one tenant', async () => {
  const { pg, db, tenantId, otherTenantId, now } = await seedTenantWithMessages([1, 20, 31, 40]);
  try {
    const removed = await purgeExpiredMessages(db, tenantId, 30, now);
    assert.equal(removed, 2, 'the 31d and 40d messages are past a 30-day window; 1d and 20d are not');
    const remaining = (await pg.query<{ body: string }>('select body from messages where tenant_id=$1 order by created_at', [tenantId])).rows.map(r => r.body);
    assert.deepEqual(remaining, ['msg-20d', 'msg-1d']);
    const otherIntact = await pg.query<{ count: string }>('select count(*)::text as count from messages where tenant_id=$1', [otherTenantId]);
    assert.equal(otherIntact.rows[0]!.count, '1', 'purging one tenant must not touch another tenant\'s messages of the same age');
  } finally { await pg.close(); }
});

test('purgeExpiredMessages floors sub-minimum retention so history is never wiped', async () => {
  const { pg, db, tenantId, now } = await seedTenantWithMessages([3, 8]);
  try {
    // MESSAGE_RETENTION_MIN_DAYS = 7 → cutoff is 7 days back, not 1, even though the
    // tenant configured retentionDays=1.
    const removed = await purgeExpiredMessages(db, tenantId, 1, now);
    assert.equal(removed, 1, 'only the 8-day-old message is past the 7-day floor; the 3-day-old one must survive');
    const remaining = (await pg.query<{ count: string }>('select count(*)::text as count from messages where tenant_id=$1', [tenantId])).rows[0]!.count;
    assert.equal(remaining, '1');
  } finally { await pg.close(); }
});
