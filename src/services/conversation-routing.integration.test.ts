import test from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseClient } from '../db/supabase.js';
import type { OwnerSettings } from './owner-settings.service.js';
import { entrySource, routeConversation } from './conversation-routing.service.js';
import { createTestDatabase, pgliteDatabaseClient } from './test-support/pglite-harness.js';

// Converted to PGlite (real migrations): routeConversation's escalations/unrecognized_routes
// reads and writes are keyed by real `uuid` columns. The previous hand-rolled mock accepted
// a bare string ('c') as a conversation id — exactly the class of bug that shipped as
// "isolated" in the simulator (a `simulation-${uuid}` id, not a real uuid) while every
// mock-backed test stayed green. Running against real Postgres types closes that gap here.

const base: OwnerSettings = { owner_phone: null, owner_chat_id: null, mode: 'mute_all', quiet_hours_start: null, quiet_hours_end: null, auto_replies_paused: false };

async function seedTenant(db: DatabaseClient): Promise<string> {
  const tenant = await db.from('tenants').insert({ name: 'T', business_name: 'B', language: 'ru', tier: 'basic', status: 'active' }).select('id').single();
  assert.equal(tenant.error, null);
  return (tenant.data as { id: string }).id;
}
async function seedConversation(db: DatabaseClient, tenantId: string, extra: Record<string, unknown> = {}) {
  const row = await db.from('conversations').insert({ tenant_id: tenantId, status: 'active', last_message_at: new Date().toISOString(), ...extra }).select('*').single();
  assert.equal(row.error, null);
  return row.data as Record<string, unknown> & { id: string };
}

test('entry source is parsed and deterministic campaign/source/open-case routes win', async () => {
  assert.equal(entrySource('go https://x.test/?utm_campaign=summer'), 'summer');

  let pg = await createTestDatabase();
  try {
    const db = pgliteDatabaseClient(pg);
    const tenant = await seedTenant(db);
    let conversation = await seedConversation(db, tenant);
    let result = await routeConversation(db, tenant, conversation as never, 'AUDIT now', { ...base, behavior: { campaign_routes: [{ keyword: 'AUDIT', agent: 'SALE' }] } }, null, undefined, true);
    assert.equal(result.kind === 'agent' && result.method, 'campaign');

    conversation = await seedConversation(db, tenant);
    result = await routeConversation(db, tenant, conversation as never, 'https://x.test/?source=catalog', { ...base, behavior: { source_routes: [{ source: 'catalog', agent: 'SALE' }] } }, null, undefined, true);
    assert.equal(result.kind === 'agent' && result.method, 'source');
    const updated = await pg.query<{ source_label: string }>('select source_label from conversations where id=$1', [conversation.id]);
    assert.equal(updated.rows[0]!.source_label, 'catalog');
  } finally { await pg.close(); }

  pg = await createTestDatabase();
  try {
    const db = pgliteDatabaseClient(pg);
    const tenant = await seedTenant(db);
    const conversation = await seedConversation(db, tenant);
    const open = await db.from('escalations').insert({ tenant_id: tenant, conversation_id: conversation.id, status: 'queued', client_chat_id: 'x@c.us', client_name: 'X', question: 'hi', session: 's' }).select('id').single();
    assert.equal(open.error, null);
    const result = await routeConversation(db, tenant, conversation as never, 'hello', base, null);
    assert.equal(result.kind === 'agent' && result.agent.name, 'SUPPORT');
  } finally { await pg.close(); }
});

test('route is sticky, another-agent signal switches, and inactivity reclassifies', async () => {
  let pg = await createTestDatabase();
  try {
    const db = pgliteDatabaseClient(pg);
    const tenant = await seedTenant(db);
    const conversation = await seedConversation(db, tenant, { routed_agent: 'SUPPORT' });
    const result = await routeConversation(db, tenant, conversation as never, 'hello', base, null);
    assert.equal(result.kind === 'agent' && result.method, 'sticky');
  } finally { await pg.close(); }

  pg = await createTestDatabase();
  try {
    const db = pgliteDatabaseClient(pg);
    const tenant = await seedTenant(db);
    const conversation = await seedConversation(db, tenant, { routed_agent: 'SUPPORT' });
    const result = await routeConversation(db, tenant, conversation as never, 'Какая цена?', base, null);
    assert.equal(result.kind === 'agent' && result.agent.name, 'SALE');
  } finally { await pg.close(); }

  pg = await createTestDatabase();
  try {
    const db = pgliteDatabaseClient(pg);
    const tenant = await seedTenant(db);
    const conversation = await seedConversation(db, tenant, { routed_agent: 'SUPPORT', last_message_at: '2020-01-01T00:00:00Z' });
    // After inactivity the route is open again: replies go to reception (its answer carries the intent),
    // the model classifier runs only for paused replies.
    const reply = await routeConversation(db, tenant, conversation as never, 'hello', base, { async generateReply() { throw new Error('classifier must not run'); } });
    assert.deepEqual([reply.kind, reply.method], ['reception', 'reception_intent']);
    const result = await routeConversation(db, tenant, conversation as never, 'hello', base, { async generateReply() { return { text: '{"agent":"SALE","confidence":0.9}' }; } }, undefined, false, true, true);
    assert.equal(result.kind === 'agent' && result.agent.name, 'SALE');
  } finally { await pg.close(); }
});

test('low confidence remains in RECEPTION unless tenant message limit is reached', async () => {
  const ai = { async generateReply() { return { text: '{"agent":"SALE","confidence":0.3}' }; } };

  let pg = await createTestDatabase();
  try {
    const db = pgliteDatabaseClient(pg);
    const tenant = await seedTenant(db);
    const conversation = await seedConversation(db, tenant);
    const result = await routeConversation(db, tenant, conversation as never, 'неясно', base, ai, undefined, false, true, true);
    assert.equal(result.kind, 'reception');
    const unresolved = await pg.query<{ count: string }>('select count(*)::text as count from unrecognized_routes where conversation_id=$1', [conversation.id]);
    assert.equal(unresolved.rows[0]!.count, '1');
  } finally { await pg.close(); }

  pg = await createTestDatabase();
  try {
    const db = pgliteDatabaseClient(pg);
    const tenant = await seedTenant(db);
    const conversation = await seedConversation(db, tenant, { routed_agent: 'RECEPTION', reception_message_count: 20 });
    const result = await routeConversation(db, tenant, conversation as never, 'всё ещё неясно', base, ai);
    assert.equal(result.kind, 'reception');
  } finally { await pg.close(); }

  pg = await createTestDatabase();
  try {
    const db = pgliteDatabaseClient(pg);
    const tenant = await seedTenant(db);
    const conversation = await seedConversation(db, tenant, { routed_agent: 'RECEPTION', reception_message_count: 2 });
    const result = await routeConversation(db, tenant, conversation as never, 'всё ещё неясно', { ...base, behavior: { reception_max_messages: 2 } }, ai);
    assert.equal(result.kind, 'escalate');
  } finally { await pg.close(); }
});
