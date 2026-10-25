-- 067 (Z10): the owner's WhatsApp groups by topic. A group is created by the backend at the first message of its
-- topic and its id kept here; a group that disappeared (or the assistant was removed from it) is marked 'lost' and
-- a new one is created. Topics are a code list (no check here), so a module adds its topic without a migration.
-- Service only: no policies for authenticated users; the backend uses the service role.
begin;

create table if not exists public.owner_channels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  topic text not null check (topic ~ '^[a-z][a-z0-9_]{0,40}$'),
  chat_id text not null check (chat_id ~ '^[0-9-]+@g\.us$'),
  status text not null default 'active' check (status in ('active','lost')),
  created_at timestamptz not null default now(),
  checked_at timestamptz not null default now()
);
create unique index if not exists owner_channels_active_topic on public.owner_channels(tenant_id, topic) where status = 'active';
create index if not exists owner_channels_chat on public.owner_channels(tenant_id, chat_id);

alter table public.owner_channels enable row level security;
revoke all on public.owner_channels from anon, authenticated;
grant select, insert, update, delete on public.owner_channels to service_role;

-- Operator settings (values set by the operator, not here):
--   group_bootstrap_number — a temporary participant (digits with country code) when WhatsApp does not allow a
--                             group without participants; removed right after the group is created;
--   owner_group_picture_url — the Leya logo set as the group picture (skipped when empty).
insert into public.system_config(key, value) values ('group_bootstrap_number', 'null'::jsonb), ('owner_group_picture_url', 'null'::jsonb)
on conflict (key) do nothing;

commit;
