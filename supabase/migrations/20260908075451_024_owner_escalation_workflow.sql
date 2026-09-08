begin;
alter table public.notification_settings
  add column if not exists time_zone text not null default 'UTC',
  add column if not exists owner_phone text,
  add column if not exists owner_chat_id text,
  add column if not exists owner_pairing_hash text,
  add column if not exists owner_pairing_expires_at timestamptz,
  add column if not exists auto_replies_paused boolean not null default false;
alter table public.clients add column if not exists time_zone text;
alter table public.conversations add column if not exists bot_paused boolean not null default false;

create unique index if not exists conversations_id_tenant_key on public.conversations(id,tenant_id);
create table if not exists public.escalations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants on delete cascade,
  conversation_id uuid not null,
  client_chat_id text not null,
  client_name text not null,
  question text not null,
  session text not null,
  inbound_id text,
  status text not null default 'queued' check (status in ('queued','notifying','pending','delivering','delivered','delivery_uncertain')),
  owner_message_ids text[] not null default '{}',
  answer text,
  client_message_id text,
  delivered_at timestamptz,
  learning_message_ids text[] not null default '{}',
  learning_state text not null default 'none' check (learning_state in ('none','prompting','awaiting','saved','declined')),
  knowledge_item_id uuid references public.knowledge_items,
  created_at timestamptz not null default now(),
  foreign key (conversation_id,tenant_id) references public.conversations(id,tenant_id),
  check (status <> 'delivered' or (answer is not null and client_message_id is not null))
);
create unique index if not exists escalation_inbound_unique on public.escalations(tenant_id,inbound_id) where inbound_id is not null;
create index if not exists escalation_owner_reply on public.escalations using gin(owner_message_ids);
create index if not exists escalation_learning_reply on public.escalations using gin(learning_message_ids);
create index if not exists escalation_tenant_status on public.escalations(tenant_id,status);
alter table public.escalations enable row level security;
alter table public.notification_settings enable row level security;
-- Operational state and pairing credentials are only written by the backend.
revoke all on public.escalations from anon, authenticated;
grant select on public.escalations to authenticated;
grant all on public.escalations to service_role;
drop policy if exists "Tenant members read escalations" on public.escalations;
create policy "Tenant members read escalations" on public.escalations for select to authenticated
using (tenant_id in (select tenant_id from public.tenant_users where user_id=(select auth.uid())));
revoke all on public.notification_settings from anon, authenticated;
grant select(id,tenant_id,quiet_hours_start,quiet_hours_end,mode,time_zone,created_at,owner_phone,owner_chat_id,auto_replies_paused) on public.notification_settings to authenticated;
grant all on public.notification_settings to service_role;
drop policy if exists "Tenant members read notification settings" on public.notification_settings;
create policy "Tenant members read notification settings" on public.notification_settings for select to authenticated
using (tenant_id in (select tenant_id from public.tenant_users where user_id=(select auth.uid())));

-- Called only after an authenticated owner's quoted confirmation. Atomic and idempotent.
create or replace function public.confirm_escalation_learning(p_tenant_id uuid,p_escalation_id uuid)
returns uuid language plpgsql security invoker set search_path = public as $$
declare e public.escalations; k uuid;
begin
  select * into e from public.escalations where tenant_id=p_tenant_id and id=p_escalation_id for update;
  if not found or e.status <> 'delivered' or e.learning_state not in ('awaiting','saved') then
    raise exception 'Escalation is not ready for learning';
  end if;
  if e.knowledge_item_id is not null then return e.knowledge_item_id; end if;
  insert into public.knowledge_items(tenant_id,type,question,answer,language,active,source)
  values(p_tenant_id,'faq',e.question,e.answer,
    case when e.question ~ '[א-ת]' then 'he' when e.question ~ '[А-Яа-яЁё]' then 'ru' else 'en' end,true,'owner_confirmed') returning id into k;
  update public.escalations set knowledge_item_id=k,learning_state='saved' where tenant_id=p_tenant_id and id=p_escalation_id;
  return k;
end $$;
revoke all on function public.confirm_escalation_learning(uuid,uuid) from public,anon,authenticated;
grant execute on function public.confirm_escalation_learning(uuid,uuid) to service_role;
commit;
