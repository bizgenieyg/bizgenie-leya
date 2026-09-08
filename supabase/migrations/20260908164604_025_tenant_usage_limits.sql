begin;
-- Keep the existing event log and tariff settings; add idempotency, not duplicates.
alter table public.usage_events add column if not exists event_key text;
create unique index if not exists usage_event_key_unique on public.usage_events(tenant_id,event_type,event_key) where event_key is not null;
create index if not exists usage_events_tenant_time_type on public.usage_events(tenant_id,created_at,event_type);
alter table public.tenant_usage_limits alter column messages_per_month drop default;
alter table public.tenant_usage_limits alter column voice_minutes_per_month drop default;
create table if not exists public.tenant_monthly_usage (
  tenant_id uuid not null references public.tenants on delete cascade,
  month date not null,
  time_zone text not null,
  messages_used bigint not null default 0 check(messages_used>=0),
  voice_seconds_used bigint not null default 0 check(voice_seconds_used>=0),
  primary key(tenant_id,month)
);
alter table public.tenant_monthly_usage enable row level security;
alter table public.usage_events enable row level security;
alter table public.tenant_usage_limits enable row level security;
-- Billing counters and limits are server-managed, not editable by tenant clients.
revoke insert,update,delete,truncate on public.usage_events from anon,authenticated;
revoke all on public.tenant_monthly_usage,public.tenant_usage_limits from anon,authenticated;
grant select on public.tenant_monthly_usage,public.tenant_usage_limits to authenticated;
grant all on public.tenant_monthly_usage,public.tenant_usage_limits,public.usage_events to service_role;
drop policy if exists "Tenant members read monthly usage" on public.tenant_monthly_usage;
create policy "Tenant members read monthly usage" on public.tenant_monthly_usage for select to authenticated
using(tenant_id in(select tenant_id from public.tenant_users where user_id=(select auth.uid())));
drop policy if exists "Tenant members read usage limits" on public.tenant_usage_limits;
create policy "Tenant members read usage limits" on public.tenant_usage_limits for select to authenticated
using(tenant_id in(select tenant_id from public.tenant_users where user_id=(select auth.uid())));
create unique index if not exists usage_notice_once_per_month on public.scheduled_jobs(tenant_id,(payload->>'month'),(payload->>'stage')) where job_type='usage_limit_notice';

create or replace function public.admit_tenant_usage(p_tenant_id uuid,p_event_key text,p_messages integer,p_voice_seconds integer,p_default_messages integer,p_default_voice_seconds integer,p_now timestamptz default now())
returns jsonb language plpgsql security invoker set search_path=public as $$
declare z text; m date; message_limit bigint; voice_limit bigint; u public.tenant_monthly_usage; event_id uuid; permitted boolean; stages text[]:='{}'; stage text;
begin
  if p_messages<0 or p_messages>1 or p_voice_seconds<0 or p_default_messages<0 or p_default_voice_seconds<0 or p_event_key is null or length(p_event_key)=0 then raise exception 'Invalid usage admission'; end if;
  select coalesce(time_zone,'UTC') into z from public.notification_settings where tenant_id=p_tenant_id;
  z:=coalesce(z,'UTC');m:=date_trunc('month',timezone(z,p_now))::date;
  select coalesce(messages_per_month,p_default_messages),coalesce(voice_minutes_per_month::bigint*60,p_default_voice_seconds) into message_limit,voice_limit from public.tenant_usage_limits where tenant_id=p_tenant_id;
  message_limit:=greatest(0,coalesce(message_limit,p_default_messages));voice_limit:=greatest(0,coalesce(voice_limit,p_default_voice_seconds));
  insert into public.tenant_monthly_usage(tenant_id,month,time_zone)values(p_tenant_id,m,z)on conflict do nothing;
  select * into u from public.tenant_monthly_usage where tenant_id=p_tenant_id and month=m for update;
  insert into public.usage_events(tenant_id,event_type,event_key,quantity,metadata,created_at)
  values(p_tenant_id,'quota_admission',p_event_key,0,jsonb_build_object('month',m),p_now)
  on conflict do nothing returning id into event_id;
  if event_id is null then return jsonb_build_object('allowed',false,'duplicate',true);end if;
  permitted:=u.messages_used+p_messages<=message_limit and (p_messages=0 or u.messages_used<message_limit)
    and (p_voice_seconds=0 or (u.voice_seconds_used+p_voice_seconds<=voice_limit and u.voice_seconds_used<voice_limit))
    and (voice_limit=0 or u.voice_seconds_used<voice_limit);
  if permitted then
    update public.tenant_monthly_usage set messages_used=messages_used+p_messages,voice_seconds_used=voice_seconds_used+p_voice_seconds
    where tenant_id=p_tenant_id and month=m returning * into u;
  end if;
  update public.usage_events set metadata=metadata||jsonb_build_object('allowed',permitted,'messages',case when permitted then p_messages else 0 end,'voice_seconds',case when permitted then p_voice_seconds else 0 end)
    where tenant_id=p_tenant_id and id=event_id;
  if u.messages_used>=message_limit or (not permitted and u.messages_used+p_messages>message_limit) then stages:=array_append(stages,'messages_100');
  elsif message_limit>0 and u.messages_used*5>=message_limit*4 then stages:=array_append(stages,'messages_80');end if;
  if (voice_limit>0 and u.voice_seconds_used>=voice_limit) or (p_voice_seconds>0 and u.voice_seconds_used+p_voice_seconds>voice_limit and not permitted) then stages:=array_append(stages,'voice_100');
  elsif voice_limit>0 and u.voice_seconds_used*5>=voice_limit*4 then stages:=array_append(stages,'voice_80');end if;
  foreach stage in array stages loop
    insert into public.scheduled_jobs(tenant_id,job_type,payload,scheduled_at,status)
    values(p_tenant_id,'usage_limit_notice',jsonb_build_object('month',m,'stage',stage,'messages_used',u.messages_used,'messages_limit',message_limit,'voice_seconds_used',u.voice_seconds_used,'voice_seconds_limit',voice_limit),p_now,'pending')on conflict do nothing;
  end loop;
  return jsonb_build_object('allowed',permitted,'duplicate',false,'month',m,'messages_used',u.messages_used,'messages_limit',message_limit,'voice_seconds_used',u.voice_seconds_used,'voice_seconds_limit',voice_limit);
end $$;
revoke all on function public.admit_tenant_usage(uuid,text,integer,integer,integer,integer,timestamptz) from public,anon,authenticated;
grant execute on function public.admit_tenant_usage(uuid,text,integer,integer,integer,integer,timestamptz) to service_role;

create or replace function public.tenant_usage_summary(p_tenant_id uuid,p_default_messages integer,p_default_voice_seconds integer,p_now timestamptz default now())
returns jsonb language plpgsql security invoker set search_path=public as $$
declare z text;m date;start_at timestamptz;end_at timestamptz;ml bigint;vl bigint;u public.tenant_monthly_usage;events jsonb;
begin
  select coalesce(time_zone,'UTC') into z from public.notification_settings where tenant_id=p_tenant_id;z:=coalesce(z,'UTC');
  m:=date_trunc('month',timezone(z,p_now))::date;start_at:=m::timestamp at time zone z;end_at:=(m+interval '1 month')::timestamp at time zone z;
  select coalesce(messages_per_month,p_default_messages),coalesce(voice_minutes_per_month::bigint*60,p_default_voice_seconds) into ml,vl from public.tenant_usage_limits where tenant_id=p_tenant_id;
  select * into u from public.tenant_monthly_usage where tenant_id=p_tenant_id and month=m;
  select jsonb_build_object('incoming_messages',coalesce(sum(quantity)filter(where event_type='message_received'),0),'outgoing_messages',coalesce(sum(quantity)filter(where event_type='message_sent'),0),'model_calls',coalesce(sum(quantity)filter(where event_type='model_call'),0),'voice_seconds_received',coalesce(sum(quantity)filter(where event_type='voice_received'),0),'input_tokens',coalesce(sum((metadata->>'input_tokens')::bigint)filter(where event_type='model_call'),0),'output_tokens',coalesce(sum((metadata->>'output_tokens')::bigint)filter(where event_type='model_call'),0),'thinking_tokens',coalesce(sum((metadata->>'thinking_tokens')::bigint)filter(where event_type='model_call'),0),'cached_input_tokens',coalesce(sum((metadata->>'cached_input_tokens')::bigint)filter(where event_type='model_call'),0),'total_tokens',coalesce(sum((metadata->>'total_tokens')::bigint)filter(where event_type='model_call'),0),'calls_without_token_usage',count(*)filter(where event_type='model_call' and not(metadata ? 'total_tokens'))) into events
  from public.usage_events where tenant_id=p_tenant_id and created_at>=start_at and created_at<end_at;
  return jsonb_build_object('month',m,'time_zone',z,'period_start',start_at,'period_end',end_at,'messages_used',coalesce(u.messages_used,0),'messages_limit',coalesce(ml,p_default_messages),'voice_seconds_used',coalesce(u.voice_seconds_used,0),'voice_minutes_used',coalesce(u.voice_seconds_used,0)/60.0,'voice_minutes_limit',coalesce(vl,p_default_voice_seconds)/60.0,'events',events);
end $$;
revoke all on function public.tenant_usage_summary(uuid,integer,integer,timestamptz) from public,anon,authenticated;
grant execute on function public.tenant_usage_summary(uuid,integer,integer,timestamptz) to service_role;
commit;
