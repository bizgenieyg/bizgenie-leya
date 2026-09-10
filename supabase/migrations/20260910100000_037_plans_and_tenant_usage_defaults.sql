begin;

-- Plans are operator-owned product data. Tenant rows may override any allowance;
-- the *_overridden flags distinguish a copied plan value from an explicit override.
create table public.plans (
  code text primary key check (code ~ '^[a-z][a-z0-9_-]{0,49}$'),
  display_name text not null check (length(btrim(display_name)) between 1 and 100),
  messages_per_month integer not null check (messages_per_month >= 0),
  voice_minutes_per_month integer not null check (voice_minutes_per_month >= 0),
  warning_percent integer not null check (warning_percent between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.plans enable row level security;
revoke all on public.plans from anon, authenticated;
grant all on public.plans to service_role;

insert into public.plans(code,display_name,messages_per_month,voice_minutes_per_month,warning_percent)
values ('basic','Базовый',500,60,80)
on conflict(code) do nothing;

insert into public.system_config(key,value)
values ('signup_default_plan','"basic"'::jsonb)
on conflict(key) do update set value='"basic"'::jsonb,updated_at=now()
where public.system_config.value #>> '{}' = 'starter';

update public.tenants set tier='basic' where tier='starter';
update public.tenant_usage_limits set plan='basic' where plan is null or plan='starter';

alter table public.tenant_usage_limits
  add column messages_overridden boolean not null default false,
  add column voice_overridden boolean not null default false,
  add column warning_overridden boolean not null default false;

-- Every pre-existing non-null value is an operator-set override and must be preserved.
update public.tenant_usage_limits set
  messages_overridden=messages_per_month is not null,
  voice_overridden=voice_minutes_per_month is not null,
  warning_overridden=warning_percent is not null;

-- Fill only missing fields. In particular, an existing messages_per_month=500 is untouched.
update public.tenant_usage_limits l set
  messages_per_month=coalesce(l.messages_per_month,p.messages_per_month),
  voice_minutes_per_month=coalesce(l.voice_minutes_per_month,p.voice_minutes_per_month),
  warning_percent=coalesce(l.warning_percent,p.warning_percent)
from public.plans p where p.code=l.plan;

-- Backfill every tenant that has no usage row.
insert into public.tenant_usage_limits(
  tenant_id,plan,messages_per_month,voice_minutes_per_month,warning_percent,
  messages_overridden,voice_overridden,warning_overridden
)
select t.id,p.code,p.messages_per_month,p.voice_minutes_per_month,p.warning_percent,false,false,false
from public.tenants t
cross join lateral (
  select p.* from public.plans p
  where p.code=coalesce((select value #>> '{}' from public.system_config where key='signup_default_plan'),'basic')
) p
where not exists(select 1 from public.tenant_usage_limits l where l.tenant_id=t.id);

create or replace function public.effective_tenant_usage_limits(p_tenant_id uuid)
returns table(plan text,messages_per_month integer,voice_minutes_per_month integer,warning_percent integer)
language sql stable security invoker set search_path=public as $$
  select p.code,
    case when coalesce(l.messages_overridden,false) then l.messages_per_month else p.messages_per_month end,
    case when coalesce(l.voice_overridden,false) then l.voice_minutes_per_month else p.voice_minutes_per_month end,
    case when coalesce(l.warning_overridden,false) then l.warning_percent else p.warning_percent end
  from public.tenant_usage_limits l join public.plans p on p.code=l.plan
  where l.tenant_id=p_tenant_id
$$;
revoke all on function public.effective_tenant_usage_limits(uuid) from public,anon,authenticated;
grant execute on function public.effective_tenant_usage_limits(uuid) to service_role;

create or replace function public.ensure_tenant_usage_limits(p_tenant_id uuid)
returns void language plpgsql security invoker set search_path=public as $$
declare v_plan text;v_plan_row public.plans%rowtype;
begin
  if exists(select 1 from public.tenant_usage_limits where tenant_id=p_tenant_id) then return;end if;
  v_plan:=coalesce((select value#>>'{}' from public.system_config where key='signup_default_plan'),'basic');
  select * into v_plan_row from public.plans where code=v_plan;
  if not found then raise exception 'Signup plan is not configured' using errcode='55000';end if;
  insert into public.tenant_usage_limits(tenant_id,plan,messages_per_month,voice_minutes_per_month,warning_percent,messages_overridden,voice_overridden,warning_overridden)
  values(p_tenant_id,v_plan,v_plan_row.messages_per_month,v_plan_row.voice_minutes_per_month,v_plan_row.warning_percent,false,false,false);
end $$;
revoke all on function public.ensure_tenant_usage_limits(uuid) from public,anon,authenticated;
grant execute on function public.ensure_tenant_usage_limits(uuid) to service_role;

-- Keep the established RPC signatures for a safe rolling deploy. Legacy default arguments
-- are deliberately ignored: plans are the sole source of default allowances.
create or replace function public.admit_tenant_usage(p_tenant_id uuid,p_event_key text,p_messages integer,p_voice_seconds integer,p_default_messages integer,p_default_voice_seconds integer,p_default_warning_percent integer,p_now timestamptz default now())
returns jsonb language plpgsql security invoker set search_path=public as $$
declare z text; m date; message_limit bigint; voice_limit bigint; u public.tenant_monthly_usage; event_id uuid; permitted boolean; stages text[]:='{}'; stage text; warning_percent integer;
begin
  if p_messages<0 or p_messages>1 or p_voice_seconds<0 or p_event_key is null or length(p_event_key)=0 then raise exception 'Invalid usage admission'; end if;
  select coalesce(time_zone,'Asia/Jerusalem') into z from public.notification_settings where tenant_id=p_tenant_id;
  select e.messages_per_month,e.voice_minutes_per_month::bigint*60,e.warning_percent into message_limit,voice_limit,warning_percent from public.effective_tenant_usage_limits(p_tenant_id) e;
  if message_limit is null or voice_limit is null or warning_percent is null then raise exception 'Tenant plan unavailable'; end if;
  z:=coalesce(z,'Asia/Jerusalem');m:=date_trunc('month',timezone(public.iana_time_zone(z),p_now))::date;
  insert into public.tenant_monthly_usage(tenant_id,month,time_zone)values(p_tenant_id,m,z)on conflict do nothing;
  select * into u from public.tenant_monthly_usage where tenant_id=p_tenant_id and month=m for update;
  insert into public.usage_events(tenant_id,event_type,event_key,quantity,metadata,created_at)
  values(p_tenant_id,'quota_admission',p_event_key,0,jsonb_build_object('month',m),p_now)
  on conflict do nothing returning id into event_id;
  if event_id is null then return jsonb_build_object('allowed',false,'duplicate',true);end if;
  permitted:=u.messages_used+p_messages<=message_limit and (p_messages=0 or u.messages_used<message_limit)
    and (p_voice_seconds=0 or (u.voice_seconds_used+p_voice_seconds<=voice_limit and u.voice_seconds_used<voice_limit));
  if permitted then update public.tenant_monthly_usage set messages_used=messages_used+p_messages,voice_seconds_used=voice_seconds_used+p_voice_seconds where tenant_id=p_tenant_id and month=m returning * into u;end if;
  update public.usage_events set metadata=metadata||jsonb_build_object('allowed',permitted,'messages',case when permitted then p_messages else 0 end,'voice_seconds',case when permitted then p_voice_seconds else 0 end) where tenant_id=p_tenant_id and id=event_id;
  if u.messages_used>=message_limit or (not permitted and u.messages_used+p_messages>message_limit) then stages:=array_append(stages,'messages_100');
  elsif message_limit>0 and u.messages_used*100>=message_limit*warning_percent then stages:=array_append(stages,'messages_warning');end if;
  if (voice_limit>0 and u.voice_seconds_used>=voice_limit) or (p_voice_seconds>0 and u.voice_seconds_used+p_voice_seconds>voice_limit and not permitted) then stages:=array_append(stages,'voice_100');
  elsif voice_limit>0 and u.voice_seconds_used*100>=voice_limit*warning_percent then stages:=array_append(stages,'voice_warning');end if;
  foreach stage in array stages loop insert into public.scheduled_jobs(tenant_id,job_type,payload,scheduled_at,status) values(p_tenant_id,'usage_limit_notice',jsonb_build_object('month',m,'stage',stage,'warning_percent',warning_percent,'messages_used',u.messages_used,'messages_limit',message_limit,'voice_seconds_used',u.voice_seconds_used,'voice_seconds_limit',voice_limit),p_now,'pending')on conflict do nothing;end loop;
  return jsonb_build_object('allowed',permitted,'duplicate',false,'month',m,'warning_percent',warning_percent,'messages_used',u.messages_used,'messages_limit',message_limit,'voice_seconds_used',u.voice_seconds_used,'voice_seconds_limit',voice_limit);
end $$;

create or replace function public.tenant_usage_summary(p_tenant_id uuid,p_default_messages integer,p_default_voice_seconds integer,p_now timestamptz default now())
returns jsonb language plpgsql security invoker set search_path=public as $$
declare z text;zi text;m date;start_at timestamptz;end_at timestamptz;ml bigint;vl bigint;u public.tenant_monthly_usage;events jsonb;
begin
  select coalesce(time_zone,'Asia/Jerusalem') into z from public.notification_settings where tenant_id=p_tenant_id;z:=coalesce(z,'Asia/Jerusalem');zi:=public.iana_time_zone(z);
  m:=date_trunc('month',timezone(zi,p_now))::date;start_at:=m::timestamp at time zone zi;end_at:=(m+interval '1 month')::timestamp at time zone zi;
  select e.messages_per_month,e.voice_minutes_per_month::bigint*60 into ml,vl from public.effective_tenant_usage_limits(p_tenant_id) e;
  if ml is null or vl is null then raise exception 'Tenant plan unavailable'; end if;
  select * into u from public.tenant_monthly_usage where tenant_id=p_tenant_id and month=m;
  select jsonb_build_object('incoming_messages',coalesce(sum(quantity)filter(where event_type='message_received'),0),'outgoing_messages',coalesce(sum(quantity)filter(where event_type='message_sent'),0),'stt_calls',coalesce(sum(quantity)filter(where event_type='stt_call'),0),'model_calls',coalesce(sum(quantity)filter(where event_type='model_call'),0),'voice_seconds_received',coalesce(sum(quantity)filter(where event_type='voice_received'),0),'input_tokens',coalesce(sum((metadata->>'input_tokens')::bigint)filter(where event_type='model_call'),0),'output_tokens',coalesce(sum((metadata->>'output_tokens')::bigint)filter(where event_type='model_call'),0),'thinking_tokens',coalesce(sum((metadata->>'thinking_tokens')::bigint)filter(where event_type='model_call'),0),'cached_input_tokens',coalesce(sum((metadata->>'cached_input_tokens')::bigint)filter(where event_type='model_call'),0),'total_tokens',coalesce(sum((metadata->>'total_tokens')::bigint)filter(where event_type='model_call'),0),'calls_without_token_usage',count(*)filter(where event_type='model_call' and not(metadata ? 'total_tokens'))) into events from public.usage_events where tenant_id=p_tenant_id and created_at>=start_at and created_at<end_at;
  return jsonb_build_object('month',m,'time_zone',z,'period_start',start_at,'period_end',end_at,'messages_used',coalesce(u.messages_used,0),'messages_limit',ml,'voice_seconds_used',coalesce(u.voice_seconds_used,0),'voice_minutes_used',coalesce(u.voice_seconds_used,0)/60.0,'voice_minutes_limit',vl/60.0,'events',events);
end $$;

create or replace function public.create_tenant_with_owner(p_name text,p_business_name text,p_language text)
returns uuid language plpgsql security definer set search_path=public as $function$
declare
  v_user_id uuid:=auth.uid();v_tenant_id uuid;v_plan text;v_plan_row public.plans%rowtype;
  v_max integer:=coalesce((select (value#>>'{}')::integer from public.system_config where key='max_tenants_per_owner'),1);v_owned integer;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode='42501';end if;
  perform pg_advisory_xact_lock(hashtextextended('create_tenant_with_owner:'||v_user_id::text,0));
  if p_name is null or btrim(p_name)='' or p_business_name is null or btrim(p_business_name)='' then raise exception 'Name and business name are required' using errcode='22023';end if;
  if p_language is null or p_language not in('he','ru','en') then raise exception 'Invalid language' using errcode='22023';end if;
  select count(*) into v_owned from public.tenant_users where user_id=v_user_id and role='owner';
  if v_owned>=greatest(v_max,0) then raise exception 'Business limit reached for this account' using errcode='54000',hint='max_tenants_per_owner';end if;
  v_plan:=coalesce((select value#>>'{}' from public.system_config where key='signup_default_plan'),'basic');
  select * into v_plan_row from public.plans where code=v_plan;
  if not found then raise exception 'Signup plan is not configured' using errcode='55000';end if;
  insert into public.tenants(name,business_name,language,tier,status,trial_ends_at) values(btrim(p_name),btrim(p_business_name),p_language,v_plan,'active',null) returning id into v_tenant_id;
  insert into public.tenant_users(tenant_id,user_id,role)values(v_tenant_id,v_user_id,'owner');
  insert into public.assistant_profiles(tenant_id)values(v_tenant_id);
  insert into public.module_settings(tenant_id,module_name,enabled,limits)values(v_tenant_id,'knowledge',true,'{}'),(v_tenant_id,'escalation',true,'{}'),(v_tenant_id,'reports',true,'{"report_frequency":"weekly"}');
  perform public.ensure_tenant_usage_limits(v_tenant_id);
  return v_tenant_id;
end;$function$;
revoke all on function public.create_tenant_with_owner(text,text,text) from public,anon;
grant execute on function public.create_tenant_with_owner(text,text,text) to authenticated;

commit;
