begin;

create table public.simulator_sessions (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  id uuid not null,
  introduced boolean not null default false,
  routed_agent text,
  route_selected_at timestamptz,
  source_label text,
  reception_message_count integer not null default 0,
  client_time_zone text,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);

create table public.simulator_messages (
  id uuid primary key default gen_random_uuid(),
  sequence bigint generated always as identity,
  tenant_id uuid not null,
  session_id uuid not null,
  from_me boolean not null,
  body text not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, session_id)
    references public.simulator_sessions(tenant_id, id) on delete cascade
);

create index simulator_messages_session_history_idx
  on public.simulator_messages (tenant_id, session_id, created_at);
create index simulator_messages_session_sequence_idx
  on public.simulator_messages (tenant_id, session_id, sequence);
create index simulator_messages_retention_idx
  on public.simulator_messages (tenant_id, created_at);

alter table public.simulator_sessions enable row level security;
alter table public.simulator_messages enable row level security;
revoke all on public.simulator_sessions, public.simulator_messages from public, anon, authenticated;
grant all on public.simulator_sessions, public.simulator_messages to service_role;

commit;
