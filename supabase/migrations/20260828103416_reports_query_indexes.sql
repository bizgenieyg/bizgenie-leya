create index idx_messages_tenant_created_at
  on public.messages (tenant_id, created_at);

create index idx_clients_tenant_first_seen_at
  on public.clients (tenant_id, first_seen_at);

create index idx_agent_actions_tenant_type_created_at
  on public.agent_actions (tenant_id, action_type, created_at)
  include (input);
