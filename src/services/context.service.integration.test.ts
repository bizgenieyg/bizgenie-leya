import assert from 'node:assert/strict';
import test from 'node:test';
import { loadContext, loadConversationMemory } from './context.service.js';
import { createTestDatabase, pgliteDatabaseClient } from './test-support/pglite-harness.js';

test('business sector from migration 050 reaches assistant context only when populated',async()=>{
 const pg=await createTestDatabase();
 try{
  const db=pgliteDatabaseClient(pg);
  const inserted=await db.from('tenants').insert({name:'Owner',business_name:'Studio',language:'ru',tier:'basic',status:'active'}).select('id').single();
  assert.equal(inserted.error,null);
  const id=(inserted.data as {id:string}).id;
  assert.deepEqual((await loadContext(db,id)).business,{owner_name:'Owner',business_name:'Studio',language:'ru'});
  const updated=await db.from('tenants').update({business_sector:'  косметолог  '}).eq('id',id);
  assert.equal(updated.error,null);
  assert.deepEqual((await loadContext(db,id)).business,{owner_name:'Owner',business_name:'Studio',language:'ru',business_sector:'косметолог'});
 }finally{await pg.close();}
});

// Converted to PGlite (real migrations, real Postgres types) per review: a hand-rolled
// mock DB cannot enforce column types/constraints and previously let a schema-breaking
// bug (simulator's non-UUID conversation id) ship as "tested". See git history of
// simulator.service.test.ts for the concrete incident this guards against here too.
//
// Mandatory review test: the model context is a read-only window. After processing a
// message, rows older than context_retention_hours must still exist in `messages`
// (weekly report, raw_payload audit, owner-takeover history) and must not reach the model.
test('loadConversationMemory never deletes and only returns rows inside the retention window', async () => {
  const pg = await createTestDatabase();
  try {
    const db = pgliteDatabaseClient(pg);
    const tenant = await db.from('tenants').insert({ name: 'T', business_name: 'B', language: 'ru', tier: 'basic', status: 'active' }).select('id').single();
    assert.equal(tenant.error, null);
    const tenantId = (tenant.data as { id: string }).id;
    const conversation = await db.from('conversations').insert({ tenant_id: tenantId, status: 'active' }).select('id').single();
    assert.equal(conversation.error, null);
    const conversationId = (conversation.data as { id: string }).id;

    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600000).toISOString();
    const rows = [
      { from_me: false, body: 'old question', created_at: hoursAgo(72), msg_type: 'text' },
      { from_me: true, body: 'old answer', created_at: hoursAgo(71), msg_type: 'text' },
      { from_me: false, body: 'recent question', created_at: hoursAgo(2), msg_type: 'text' },
      { from_me: true, body: 'recent answer', created_at: hoursAgo(1), msg_type: 'text' },
      { from_me: true, body: 'owner took over', created_at: hoursAgo(1), msg_type: 'owner_text' },
    ];
    for (const row of rows) {
      const inserted = await db.from('messages').insert({ tenant_id: tenantId, conversation_id: conversationId, ...row }).select('id').single();
      assert.equal(inserted.error, null);
    }

    const before = await pg.query<{ count: string }>('select count(*)::text as count from messages where conversation_id=$1', [conversationId]);
    assert.equal(before.rows[0]!.count, '5');

    const memory = await loadConversationMemory(db, tenantId, conversationId, 10, 48);

    const after = await pg.query<{ count: string }>('select count(*)::text as count from messages where conversation_id=$1', [conversationId]);
    assert.equal(after.rows[0]!.count, '5', 'must not delete message rows on the hot path — real DELETE would show here');
    assert.deepEqual(memory.messages.map(m => m.text), ['recent question', 'recent answer'], 'owner_text rows are excluded and the retention window is respected');
    assert.equal(memory.introduced, false);
  } finally {
    await pg.close();
  }
});
