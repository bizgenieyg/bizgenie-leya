begin;

create table public.inbound_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  waha_event_id text not null,
  chat_id text not null,
  kind text not null check (kind in ('client','immediate','outgoing','ignored')),
  payload jsonb not null,
  received_at timestamptz not null default now(),
  process_after timestamptz not null default now(),
  status text not null default 'pending'
    check (status in ('pending','processing','done','failed','ignored')),
  attempts integer not null default 0 check (attempts >= 0),
  started_at timestamptz,
  processed_at timestamptz,
  error text,
  unique (tenant_id, waha_event_id)
);

create index inbound_events_next_pending_idx
  on public.inbound_events (process_after, received_at, id)
  where status = 'pending';
create index inbound_events_chat_pending_idx
  on public.inbound_events (tenant_id, chat_id, received_at, id)
  where status = 'pending';
create index inbound_events_stale_processing_idx
  on public.inbound_events (started_at)
  where status = 'processing';
create index inbound_events_retention_idx
  on public.inbound_events (processed_at)
  where status in ('done','ignored','failed');

alter table public.inbound_events enable row level security;
revoke all on public.inbound_events from anon, authenticated;
grant select, insert, update, delete on public.inbound_events to service_role;

alter table public.messages add column inbound_event_id uuid references public.inbound_events(id) on delete set null;
create unique index messages_one_inbound_event_idx on public.messages(inbound_event_id)
  where inbound_event_id is not null;

commit;
