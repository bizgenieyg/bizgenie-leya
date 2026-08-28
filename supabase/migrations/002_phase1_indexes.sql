create index idx_clients_tenant_phone
  on public.clients (tenant_id, phone);

create index idx_conversations_tenant_client
  on public.conversations (tenant_id, client_id);

create index idx_messages_conversation
  on public.messages (conversation_id, created_at);

create index idx_knowledge_tenant
  on public.knowledge_items (tenant_id, type, active);

create index idx_services_tenant
  on public.services (tenant_id, active);

create index idx_usage_events_tenant
  on public.usage_events (tenant_id, event_type, created_at);

create index idx_scheduled_jobs
  on public.scheduled_jobs (scheduled_at, status);

create index idx_system_logs_tenant
  on public.system_logs (tenant_id, created_at);

create index idx_onboarding_sessions_token
  on public.onboarding_sessions (setup_token_hash);
