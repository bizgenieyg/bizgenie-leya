begin;

-- POSIX vs IANA sign trap: Postgres reads 'UTC+3' the POSIX way (3 hours WEST of UTC),
-- so date_trunc('month', timezone('UTC+3', now())) and (m::timestamp at time zone 'UTC+3')
-- landed a tenant's month boundary 2x offset hours off, pushing midnight of the 1st into
-- the neighbouring month. Translate the product's UTC±N labels to their IANA equivalents
-- (Etc/GMT has the opposite sign) before handing them to timezone()/at time zone, mirroring
-- intlTimeZone() in src/config/time-zones.ts. The stored notification_settings.time_zone keeps
-- the canonical 'UTC+3' label the owner picked; only the point of use is translated.
create or replace function public.iana_time_zone(p_zone text)
returns text language sql immutable set search_path=public as $$
  select case
    when p_zone is null then null
    when p_zone ~ '^UTC[+-]0{1,2}$' then 'UTC'
    when p_zone ~ '^UTC[+-][0-9]{1,2}$'
      then 'Etc/GMT' || (case when substr(p_zone,4,1)='+' then '-' else '+' end) || ltrim(substr(p_zone,5),'0')
    else p_zone
  end
$$;
revoke all on function public.iana_time_zone(text) from public,anon,authenticated;
grant execute on function public.iana_time_zone(text) to anon,authenticated,service_role;

-- Same signature as migration 026: create or replace keeps existing grants.
create or replace function public.admit_tenant_usage(p_tenant_id uuid,p_event_key text,p_messages integer,p_voice_seconds integer,p_default_messages integer,p_default_voice_seconds integer,p_default_warning_percent integer,p_now timestamptz default now())
returns jsonb language plpgsql security invoker set search_path=public as $$
declare z text; m date; message_limit bigint; voice_limit bigint; u public.tenant_monthly_usage; event_id uuid; permitted boolean; stages text[]:='{}'; stage text; warning_percent integer;
begin
  if p_messages<0 or p_messages>1 or p_voice_seconds<0 or p_default_messages<0 or p_default_voice_seconds<0 or p_event_key is null or length(p_event_key)=0 then raise exception 'Invalid usage admission'; end if;
  select coalesce(time_zone,'Asia/Jerusalem') into z from public.notification_settings where tenant_id=p_tenant_id;
  select coalesce(l.warning_percent,p_default_warning_percent) into warning_percent from public.tenant_usage_limits l where tenant_id=p_tenant_id; warning_percent:=coalesce(warning_percent,p_default_warning_percent);
  z:=coalesce(z,'Asia/Jerusalem');m:=date_trunc('month',timezone(public.iana_time_zone(z),p_now))::date;
  select coalesce(messages_per_month,p_default_messages),coalesce(voice_minutes_per_month::bigint*60,p_default_voice_seconds) into message_limit,voice_limit from public.tenant_usage_limits where tenant_id=p_tenant_id;
  message_limit:=greatest(0,coalesce(message_limit,p_default_messages));voice_limit:=greatest(0,coalesce(voice_limit,p_default_voice_seconds));
  insert into public.tenant_monthly_usage(tenant_id,month,time_zone)values(p_tenant_id,m,z)on conflict do nothing;
  select * into u from public.tenant_monthly_usage where tenant_id=p_tenant_id and month=m for update;
  insert into public.usage_events(tenant_id,event_type,event_key,quantity,metadata,created_at)
  values(p_tenant_id,'quota_admission',p_event_key,0,jsonb_build_object('month',m),p_now)
  on conflict do nothing returning id into event_id;
  if event_id is null then return jsonb_build_object('allowed',false,'duplicate',true);end if;
  permitted:=u.messages_used+p_messages<=message_limit and (p_messages=0 or u.messages_used<message_limit)
    and (p_voice_seconds=0 or (u.voice_seconds_used+p_voice_seconds<=voice_limit and u.voice_seconds_used<voice_limit));
  if permitted then
    update public.tenant_monthly_usage set messages_used=messages_used+p_messages,voice_seconds_used=voice_seconds_used+p_voice_seconds
    where tenant_id=p_tenant_id and month=m returning * into u;
  end if;
  update public.usage_events set metadata=metadata||jsonb_build_object('allowed',permitted,'messages',case when permitted then p_messages else 0 end,'voice_seconds',case when permitted then p_voice_seconds else 0 end)
    where tenant_id=p_tenant_id and id=event_id;
  if u.messages_used>=message_limit or (not permitted and u.messages_used+p_messages>message_limit) then stages:=array_append(stages,'messages_100');
  elsif message_limit>0 and u.messages_used*100>=message_limit*warning_percent then stages:=array_append(stages,'messages_warning');end if;
  if (voice_limit>0 and u.voice_seconds_used>=voice_limit) or (p_voice_seconds>0 and u.voice_seconds_used+p_voice_seconds>voice_limit and not permitted) then stages:=array_append(stages,'voice_100');
  elsif voice_limit>0 and u.voice_seconds_used*100>=voice_limit*warning_percent then stages:=array_append(stages,'voice_warning');end if;
  foreach stage in array stages loop
    insert into public.scheduled_jobs(tenant_id,job_type,payload,scheduled_at,status)
    values(p_tenant_id,'usage_limit_notice',jsonb_build_object('month',m,'stage',stage,'warning_percent',warning_percent,'messages_used',u.messages_used,'messages_limit',message_limit,'voice_seconds_used',u.voice_seconds_used,'voice_seconds_limit',voice_limit),p_now,'pending')on conflict do nothing;
  end loop;
  return jsonb_build_object('allowed',permitted,'duplicate',false,'month',m,'warning_percent',warning_percent,'messages_used',u.messages_used,'messages_limit',message_limit,'voice_seconds_used',u.voice_seconds_used,'voice_seconds_limit',voice_limit);
end $$;

create or replace function public.tenant_usage_summary(p_tenant_id uuid,p_default_messages integer,p_default_voice_seconds integer,p_now timestamptz default now())
returns jsonb language plpgsql security invoker set search_path=public as $$
declare z text;zi text;m date;start_at timestamptz;end_at timestamptz;ml bigint;vl bigint;u public.tenant_monthly_usage;events jsonb;
begin
  select coalesce(time_zone,'Asia/Jerusalem') into z from public.notification_settings where tenant_id=p_tenant_id;z:=coalesce(z,'Asia/Jerusalem');zi:=public.iana_time_zone(z);
  m:=date_trunc('month',timezone(zi,p_now))::date;start_at:=m::timestamp at time zone zi;end_at:=(m+interval '1 month')::timestamp at time zone zi;
  select coalesce(messages_per_month,p_default_messages),coalesce(voice_minutes_per_month::bigint*60,p_default_voice_seconds) into ml,vl from public.tenant_usage_limits where tenant_id=p_tenant_id;
  select * into u from public.tenant_monthly_usage where tenant_id=p_tenant_id and month=m;
  select jsonb_build_object('incoming_messages',coalesce(sum(quantity)filter(where event_type='message_received'),0),'outgoing_messages',coalesce(sum(quantity)filter(where event_type='message_sent'),0),'stt_calls',coalesce(sum(quantity)filter(where event_type='stt_call'),0),'model_calls',coalesce(sum(quantity)filter(where event_type='model_call'),0),'voice_seconds_received',coalesce(sum(quantity)filter(where event_type='voice_received'),0),'input_tokens',coalesce(sum((metadata->>'input_tokens')::bigint)filter(where event_type='model_call'),0),'output_tokens',coalesce(sum((metadata->>'output_tokens')::bigint)filter(where event_type='model_call'),0),'thinking_tokens',coalesce(sum((metadata->>'thinking_tokens')::bigint)filter(where event_type='model_call'),0),'cached_input_tokens',coalesce(sum((metadata->>'cached_input_tokens')::bigint)filter(where event_type='model_call'),0),'total_tokens',coalesce(sum((metadata->>'total_tokens')::bigint)filter(where event_type='model_call'),0),'calls_without_token_usage',count(*)filter(where event_type='model_call' and not(metadata ? 'total_tokens'))) into events
  from public.usage_events where tenant_id=p_tenant_id and created_at>=start_at and created_at<end_at;
  return jsonb_build_object('month',m,'time_zone',z,'period_start',start_at,'period_end',end_at,'messages_used',coalesce(u.messages_used,0),'messages_limit',coalesce(ml,p_default_messages),'voice_seconds_used',coalesce(u.voice_seconds_used,0),'voice_minutes_used',coalesce(u.voice_seconds_used,0)/60.0,'voice_minutes_limit',coalesce(vl,p_default_voice_seconds)/60.0,'events',events);
end $$;

commit;
