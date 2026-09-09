import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseClient } from '../db/supabase.js';
import { loadConversationMemory } from './context.service.js';

interface Row { from_me: boolean; body: string; created_at: string; msg_type: string }

// Mandatory review test: the model context is a read-only window. After processing a
// message, rows older than context_retention_hours must still exist in `messages`
// (weekly report, raw_payload audit, owner-takeover history) and must not reach the model.
test('loadConversationMemory never deletes and only returns rows inside the retention window', async () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600000).toISOString();
  const store: Row[] = [
    { from_me: false, body: 'old question', created_at: hoursAgo(72), msg_type: 'text' },
    { from_me: true, body: 'old answer', created_at: hoursAgo(71), msg_type: 'text' },
    { from_me: false, body: 'recent question', created_at: hoursAgo(2), msg_type: 'text' },
    { from_me: true, body: 'recent answer', created_at: hoursAgo(1), msg_type: 'text' },
    { from_me: true, body: 'owner took over', created_at: hoursAgo(1), msg_type: 'owner_text' },
  ];
  let deleteCalled = false;

  const db = {
    from(table: string) {
      const filters: { gte?: string; msgType?: string } = {};
      let limitN = Infinity;
      const chain: Record<string, unknown> = {
        select() { return chain; },
        eq(column: string, value: unknown) { if (column === 'msg_type') filters.msgType = String(value); return chain; },
        gte(_column: string, value: string) { filters.gte = value; return chain; },
        order() { return chain; },
        limit(n: number) { limitN = n; return chain; },
        delete() { deleteCalled = true; return chain; },
        lt() { return chain; },
        async maybeSingle() { return { data: { assistant_introduced_at: null }, error: null }; },
        then(resolve: (value: unknown) => unknown) {
          if (table !== 'messages') return Promise.resolve(resolve({ data: [], error: null }));
          const rows = store
            .filter(r => (!filters.msgType || r.msg_type === filters.msgType) && (!filters.gte || r.created_at >= filters.gte))
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
            .slice(0, limitN)
            .map(r => ({ from_me: r.from_me, body: r.body, created_at: r.created_at }));
          return Promise.resolve(resolve({ data: rows, error: null }));
        },
      };
      return chain;
    },
  } as unknown as DatabaseClient;

  const memory = await loadConversationMemory(db, 'tenant', 'conversation', 10, 48);

  assert.equal(deleteCalled, false, 'must not delete message rows on the hot path');
  assert.equal(store.length, 5, 'stored history is untouched');
  assert.deepEqual(memory.messages.map(m => m.text), ['recent question', 'recent answer']);
  assert.equal(memory.introduced, false);
});
