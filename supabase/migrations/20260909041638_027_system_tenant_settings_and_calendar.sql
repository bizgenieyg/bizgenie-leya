begin;

alter table public.tenant_usage_limits
  add column if not exists plan text;
alter table public.notification_settings alter column time_zone drop default;

create table if not exists public.schedule_exceptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  kind text not null check (kind in ('day_off','special_hours')),
  work_start time,
  work_end time,
  name text not null check (length(btrim(name)) between 1 and 120),
  recurs_annually boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date),
  check (
    (kind='day_off' and work_start is null and work_end is null) or
    (kind='special_hours' and work_start is not null and work_end is not null and work_start<>work_end)
  )
);
create index if not exists schedule_exceptions_tenant_dates
  on public.schedule_exceptions(tenant_id,start_date,end_date);
alter table public.schedule_exceptions enable row level security;
revoke all on public.schedule_exceptions from anon,authenticated;
grant select,insert,update,delete on public.schedule_exceptions to authenticated;
grant all on public.schedule_exceptions to service_role;

drop policy if exists "Tenant members read schedule exceptions" on public.schedule_exceptions;
create policy "Tenant members read schedule exceptions" on public.schedule_exceptions
for select to authenticated using (
  tenant_id in (select tenant_id from public.tenant_users where user_id=(select auth.uid()))
);
drop policy if exists "Tenant admins insert schedule exceptions" on public.schedule_exceptions;
create policy "Tenant admins insert schedule exceptions" on public.schedule_exceptions
for insert to authenticated with check (
  exists(select 1 from public.tenant_users where tenant_id=schedule_exceptions.tenant_id
    and user_id=(select auth.uid()) and role in ('owner','admin'))
);
drop policy if exists "Tenant admins update schedule exceptions" on public.schedule_exceptions;
create policy "Tenant admins update schedule exceptions" on public.schedule_exceptions
for update to authenticated using (
  exists(select 1 from public.tenant_users where tenant_id=schedule_exceptions.tenant_id
    and user_id=(select auth.uid()) and role in ('owner','admin'))
) with check (
  exists(select 1 from public.tenant_users where tenant_id=schedule_exceptions.tenant_id
    and user_id=(select auth.uid()) and role in ('owner','admin'))
);
drop policy if exists "Tenant admins delete schedule exceptions" on public.schedule_exceptions;
create policy "Tenant admins delete schedule exceptions" on public.schedule_exceptions
for delete to authenticated using (
  exists(select 1 from public.tenant_users where tenant_id=schedule_exceptions.tenant_id
    and user_id=(select auth.uid()) and role in ('owner','admin'))
);

-- 024 granted a fixed column list; include the runtime columns introduced by 026.
grant select(translate_owner_answer,behavior,templates) on public.notification_settings to authenticated;

-- Tenant settings RPC can no longer receive or mutate billing settings.
drop function if exists public.update_tenant_runtime_settings(uuid,jsonb,jsonb,jsonb);
create or replace function public.update_tenant_runtime_settings(
  p_tenant_id uuid,p_notification jsonb,p_behavior jsonb,p_default_time_zone text
) returns void language plpgsql security invoker set search_path=public as $$
begin
  insert into public.notification_settings(tenant_id,time_zone) values(p_tenant_id,p_default_time_zone)
  on conflict(tenant_id) do nothing;
  update public.notification_settings set
    behavior=coalesce(behavior,'{}'::jsonb)||p_behavior,
    translate_owner_answer=case when p_notification?'translate_owner_answer' then (p_notification->>'translate_owner_answer')::boolean else translate_owner_answer end,
    auto_replies_paused=case when p_notification?'auto_replies_paused' then (p_notification->>'auto_replies_paused')::boolean else auto_replies_paused end,
    time_zone=coalesce(p_notification->>'time_zone',time_zone)
  where tenant_id=p_tenant_id;
end $$;
revoke all on function public.update_tenant_runtime_settings(uuid,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.update_tenant_runtime_settings(uuid,jsonb,jsonb,text) to service_role;

-- Convert the legacy quiet interval into equal working hours for every weekday.
update public.notification_settings set behavior=coalesce(behavior,'{}'::jsonb)||jsonb_build_object(
  'weekly_schedule',(
    select jsonb_object_agg(day,jsonb_build_object('mode','working_hours','start',to_char(quiet_hours_end,'HH24:MI'),'end',to_char(quiet_hours_start,'HH24:MI')))
    from unnest(array['0','1','2','3','4','5','6']) day
  )
)
where quiet_hours_start is not null and quiet_hours_end is not null
  and not coalesce(behavior,'{}'::jsonb)?'weekly_schedule';

commit;
