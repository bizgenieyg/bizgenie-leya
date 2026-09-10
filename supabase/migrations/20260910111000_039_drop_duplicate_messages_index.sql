begin;

-- Migration 032 created the canonical equivalent index. Remove the historical duplicate
-- forward; the already-applied 20260828103416 migration remains immutable.
drop index if exists public.idx_messages_tenant_created_at;

commit;
