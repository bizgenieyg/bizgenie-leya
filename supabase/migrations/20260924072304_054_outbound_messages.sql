begin;

create table public.outbound_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  session text not null,
  chat_id text not null,
  text text not null,
  kind text not null check (kind in ('reply','owner_notice','owner_answer_delivery','summary','reminder','broadcast')),
  priority smallint not null check (priority between 0 and 3),
  not_before timestamptz not null default now(),
  deadline_at timestamptz,
  status text not null default 'pending' check (status in ('pending','sending','sent','failed','cancelled','expired')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  dedupe_key text not null,
  inbound_message_ids text[] not null default '{}',
  waha_msg_id text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  sent_at timestamptz,
  unique (tenant_id,dedupe_key)
);

create index outbound_next_idx on public.outbound_messages(not_before, priority, created_at)
  where status = 'pending';
create index outbound_session_idx on public.outbound_messages(session, priority, not_before, created_at)
  where status = 'pending';
create index outbound_stale_idx on public.outbound_messages(started_at)
  where status = 'sending';
create index outbound_retention_sent_idx on public.outbound_messages(tenant_id,sent_at)
  where status = 'sent';
create index outbound_retention_terminal_idx on public.outbound_messages(tenant_id,created_at)
  where status in ('failed','cancelled','expired');

alter table public.outbound_messages enable row level security;
revoke all on public.outbound_messages from anon, authenticated;
grant select, insert, update, delete on public.outbound_messages to service_role;

commit;
