import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('platform_feedback migration grants insert only and keeps reads service-role-only', () => {
  const sql = readFileSync('supabase/migrations/20260922181956_platform_feedback.sql', 'utf8');
  assert.match(sql, /alter table public\.platform_feedback enable row level security/i);
  assert.match(sql, /revoke all on table public\.platform_feedback from anon, authenticated/i);
  assert.match(sql, /grant insert on table public\.platform_feedback to authenticated/i);
  assert.match(sql, /grant select, insert, update, delete on table public\.platform_feedback to service_role/i);
  assert.match(sql, /tenant_users\.user_id = \(select auth\.uid\(\)\)/i);
  assert.doesNotMatch(sql, /for select\s+to authenticated/i);
});
