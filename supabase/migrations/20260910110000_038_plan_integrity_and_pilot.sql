begin;

alter table public.plans add column unlimited boolean not null default false;

insert into public.plans(code,display_name,messages_per_month,voice_minutes_per_month,warning_percent,unlimited)
values('pilot','Пилотный',0,0,80,true)
on conflict(code) do update set display_name=excluded.display_name,unlimited=true,updated_at=now();

-- Audit inherited values against the plan that supplied them. Equal values are not
-- individual commercial overrides. This includes the known 30 August tenant.
update public.tenant_usage_limits l set
  messages_overridden=false
from public.plans p
where p.code=l.plan and l.messages_overridden and l.messages_per_month=p.messages_per_month;
update public.tenant_usage_limits l set
  voice_overridden=false
from public.plans p
where p.code=l.plan and l.voice_overridden and l.voice_minutes_per_month=p.voice_minutes_per_month;
update public.tenant_usage_limits l set
  warning_overridden=false
from public.plans p
where p.code=l.plan and l.warning_overridden and l.warning_percent=p.warning_percent;
update public.tenant_usage_limits set messages_overridden=false
where tenant_id='f234ec3f-7f69-4771-add4-a8a083f6a078'::uuid;

-- Pilot becomes the signup plan and the assigned plan for all current tenants.
update public.system_config set value='"pilot"'::jsonb,updated_at=now()
where key='signup_default_plan';
insert into public.system_config(key,value) values('signup_default_plan','"pilot"'::jsonb)
on conflict(key) do nothing;
update public.tenant_usage_limits set plan='pilot';
update public.tenants set tier='pilot';

alter table public.tenant_usage_limits alter column plan set not null;
alter table public.tenant_usage_limits
  add constraint tenant_usage_limits_plan_fkey foreign key(plan) references public.plans(code)
  on delete restrict on update cascade;

create or replace function public.validate_signup_default_plan()
returns trigger language plpgsql security invoker set search_path=public as $$
declare v_code text;
begin
  if new.key<>'signup_default_plan' then return new;end if;
  v_code:=new.value#>>'{}';
  if v_code is null or not exists(select 1 from public.plans where code=v_code) then
    raise exception 'signup_default_plan must reference plans.code' using errcode='23503';
  end if;
  return new;
end $$;
revoke all on function public.validate_signup_default_plan() from public,anon,authenticated;

create trigger validate_signup_default_plan
before insert or update of value on public.system_config
for each row execute function public.validate_signup_default_plan();

create or replace function public.sync_signup_default_plan_code()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
  if tg_op='DELETE' then
    if exists(select 1 from public.system_config where key='signup_default_plan' and value#>>'{}'=old.code) then
      raise exception 'Plan is the signup default' using errcode='23503';
    end if;
    return old;
  end if;
  if new.code<>old.code then
    update public.system_config set value=to_jsonb(new.code),updated_at=now()
    where key='signup_default_plan' and value#>>'{}'=old.code;
  end if;
  return new;
end $$;
revoke all on function public.sync_signup_default_plan_code() from public,anon,authenticated;
create trigger sync_signup_default_plan_code
after update of code or delete on public.plans
for each row execute function public.sync_signup_default_plan_code();

drop function public.effective_tenant_usage_limits(uuid);
create function public.effective_tenant_usage_limits(p_tenant_id uuid)
returns table(plan text,messages_per_month integer,voice_minutes_per_month integer,warning_percent integer,unlimited boolean)
language sql stable security invoker set search_path=public as $$
  select p.code,
    case when coalesce(l.messages_overridden,false) then l.messages_per_month else p.messages_per_month end,
    case when coalesce(l.voice_overridden,false) then l.voice_minutes_per_month else p.voice_minutes_per_month end,
    case when coalesce(l.warning_overridden,false) then l.warning_percent else p.warning_percent end,
    p.unlimited
  from public.tenant_usage_limits l join public.plans p on p.code=l.plan
  where l.tenant_id=p_tenant_id
$$;
revoke all on function public.effective_tenant_usage_limits(uuid) from public,anon,authenticated;
grant execute on function public.effective_tenant_usage_limits(uuid) to service_role;

create or replace function public.admit_tenant_usage(p_tenant_id uuid,p_event_key text,p_messages integer,p_voice_seconds integer,p_default_messages integer,p_default_voice_seconds integer,p_default_warning_percent integer,p_now timestamptz default now())
returns jsonb language plpgsql security invoker set search_path=public as $$
declare z text;m date;message_limit bigint;voice_limit bigint;u public.tenant_monthly_usage;event_id uuid;permitted boolean;stages text[]:='{}';stage text;warning_percent integer;is_unlimited boolean;
begin
  if p_messages<0 or p_messages>1 or p_voice_seconds<0 or p_event_key is null or length(p_event_key)=0 then raise exception 'Invalid usage admission';end if;
  select coalesce(time_zone,'Asia/Jerusalem') into z from public.notification_settings where tenant_id=p_tenant_id;
  select e.messages_per_month,e.voice_minutes_per_month::bigint*60,e.warning_percent,e.unlimited into message_limit,voice_limit,warning_percent,is_unlimited from public.effective_tenant_usage_limits(p_tenant_id)e;
  if is_unlimited is null then raise exception 'CRITICAL: tenant plan integrity violation';end if;
  z:=coalesce(z,'Asia/Jerusalem');m:=date_trunc('month',timezone(public.iana_time_zone(z),p_now))::date;
  insert into public.tenant_monthly_usage(tenant_id,month,time_zone)values(p_tenant_id,m,z)on conflict do nothing;
  select * into u from public.tenant_monthly_usage where tenant_id=p_tenant_id and month=m for update;
  insert into public.usage_events(tenant_id,event_type,event_key,quantity,metadata,created_at)values(p_tenant_id,'quota_admission',p_event_key,0,jsonb_build_object('month',m),p_now)on conflict do nothing returning id into event_id;
  if event_id is null then return jsonb_build_object('allowed',false,'duplicate',true);end if;
  permitted:=is_unlimited or (u.messages_used+p_messages<=message_limit and (p_messages=0 or u.messages_used<message_limit) and (p_voice_seconds=0 or(u.voice_seconds_used+p_voice_seconds<=voice_limit and u.voice_seconds_used<voice_limit)));
  if permitted then update public.tenant_monthly_usage set messages_used=messages_used+p_messages,voice_seconds_used=voice_seconds_used+p_voice_seconds where tenant_id=p_tenant_id and month=m returning * into u;end if;
  update public.usage_events set metadata=metadata||jsonb_build_object('allowed',permitted,'unlimited',is_unlimited,'messages',case when permitted then p_messages else 0 end,'voice_seconds',case when permitted then p_voice_seconds else 0 end)where tenant_id=p_tenant_id and id=event_id;
  if not is_unlimited then
    if u.messages_used>=message_limit or(not permitted and u.messages_used+p_messages>message_limit)then stages:=array_append(stages,'messages_100');elsif message_limit>0 and u.messages_used*100>=message_limit*warning_percent then stages:=array_append(stages,'messages_warning');end if;
    if(voice_limit>0 and u.voice_seconds_used>=voice_limit)or(p_voice_seconds>0 and u.voice_seconds_used+p_voice_seconds>voice_limit and not permitted)then stages:=array_append(stages,'voice_100');elsif voice_limit>0 and u.voice_seconds_used*100>=voice_limit*warning_percent then stages:=array_append(stages,'voice_warning');end if;
    foreach stage in array stages loop insert into public.scheduled_jobs(tenant_id,job_type,payload,scheduled_at,status)values(p_tenant_id,'usage_limit_notice',jsonb_build_object('month',m,'stage',stage,'warning_percent',warning_percent,'messages_used',u.messages_used,'messages_limit',message_limit,'voice_seconds_used',u.voice_seconds_used,'voice_seconds_limit',voice_limit),p_now,'pending')on conflict do nothing;end loop;
  end if;
  return jsonb_build_object('allowed',permitted,'duplicate',false,'unlimited',is_unlimited,'month',m,'warning_percent',warning_percent,'messages_used',u.messages_used,'messages_limit',message_limit,'voice_seconds_used',u.voice_seconds_used,'voice_seconds_limit',voice_limit);
end $$;

create or replace function public.tenant_usage_summary(p_tenant_id uuid,p_default_messages integer,p_default_voice_seconds integer,p_now timestamptz default now())
returns jsonb language plpgsql security invoker set search_path=public as $$
declare z text;zi text;m date;start_at timestamptz;end_at timestamptz;ml bigint;vl bigint;is_unlimited boolean;u public.tenant_monthly_usage;events jsonb;
begin
  select coalesce(time_zone,'Asia/Jerusalem')into z from public.notification_settings where tenant_id=p_tenant_id;z:=coalesce(z,'Asia/Jerusalem');zi:=public.iana_time_zone(z);
  m:=date_trunc('month',timezone(zi,p_now))::date;start_at:=m::timestamp at time zone zi;end_at:=(m+interval'1 month')::timestamp at time zone zi;
  select e.messages_per_month,e.voice_minutes_per_month::bigint*60,e.unlimited into ml,vl,is_unlimited from public.effective_tenant_usage_limits(p_tenant_id)e;
  if is_unlimited is null then raise exception 'CRITICAL: tenant plan integrity violation';end if;
  select * into u from public.tenant_monthly_usage where tenant_id=p_tenant_id and month=m;
  select jsonb_build_object('incoming_messages',coalesce(sum(quantity)filter(where event_type='message_received'),0),'outgoing_messages',coalesce(sum(quantity)filter(where event_type='message_sent'),0),'stt_calls',coalesce(sum(quantity)filter(where event_type='stt_call'),0),'model_calls',coalesce(sum(quantity)filter(where event_type='model_call'),0),'voice_seconds_received',coalesce(sum(quantity)filter(where event_type='voice_received'),0),'input_tokens',coalesce(sum((metadata->>'input_tokens')::bigint)filter(where event_type='model_call'),0),'output_tokens',coalesce(sum((metadata->>'output_tokens')::bigint)filter(where event_type='model_call'),0),'thinking_tokens',coalesce(sum((metadata->>'thinking_tokens')::bigint)filter(where event_type='model_call'),0),'cached_input_tokens',coalesce(sum((metadata->>'cached_input_tokens')::bigint)filter(where event_type='model_call'),0),'total_tokens',coalesce(sum((metadata->>'total_tokens')::bigint)filter(where event_type='model_call'),0),'calls_without_token_usage',count(*)filter(where event_type='model_call'and not(metadata?'total_tokens')))into events from public.usage_events where tenant_id=p_tenant_id and created_at>=start_at and created_at<end_at;
  return jsonb_build_object('month',m,'time_zone',z,'period_start',start_at,'period_end',end_at,'unlimited',is_unlimited,'messages_used',coalesce(u.messages_used,0),'messages_limit',ml,'voice_seconds_used',coalesce(u.voice_seconds_used,0),'voice_minutes_used',coalesce(u.voice_seconds_used,0)/60.0,'voice_minutes_limit',vl/60.0,'events',events);
end $$;

commit;
