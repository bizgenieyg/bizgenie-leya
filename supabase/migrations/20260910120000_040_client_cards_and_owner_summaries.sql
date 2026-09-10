begin;

alter table public.clients
  add column if not exists whatsapp_jid text,
  add column if not exists language_overridden boolean not null default false,
  add column if not exists auto_reply_allowed boolean not null default true,
  add column if not exists auto_reply_opted_out_at timestamptz;
update public.clients set whatsapp_jid=case when phone like '%@%' then phone else phone||'@c.us' end where whatsapp_jid is null;
alter table public.clients alter column whatsapp_jid set not null;
create unique index if not exists clients_tenant_whatsapp_jid on public.clients(tenant_id,whatsapp_jid);

alter table public.conversations drop constraint if exists conversations_client_id_fkey;
alter table public.conversations add constraint conversations_client_id_fkey
  foreign key(client_id) references public.clients(id) on delete set null;
alter table public.client_profiles drop constraint if exists client_profiles_client_id_fkey;
alter table public.client_profiles add constraint client_profiles_client_id_fkey
  foreign key(client_id) references public.clients(id) on delete cascade;

create index if not exists clients_tenant_last_seen
  on public.clients(tenant_id,last_seen_at desc);
create index if not exists conversations_tenant_client_created
  on public.conversations(tenant_id,client_id,created_at desc);

-- One delivery receipt per reporting period makes scheduler retries idempotent.
create unique index if not exists scheduled_owner_summary_period_unique
  on public.scheduled_jobs(tenant_id,job_type,(payload->>'period_key'))
  where job_type='owner_summary';

-- Existing tenant RLS policies apply to the added client columns. Explicitly preserve
-- owner/admin-only writes and tenant-member reads from the canonical policy set.
alter table public.clients enable row level security;

commit;
