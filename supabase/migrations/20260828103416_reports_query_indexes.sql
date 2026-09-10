-- Covered by idx_messages_tenant_created from migration 032. Keeping both would
-- duplicate the same (tenant_id, created_at) btree and add write overhead.

create index idx_clients_tenant_first_seen_at
  on public.clients (tenant_id, first_seen_at);

create index idx_agent_actions_tenant_type_created_at
  on public.agent_actions (tenant_id, action_type, created_at)
  include (input);
