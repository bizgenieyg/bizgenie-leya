begin;
-- One-time upgrade of the former disabled voice default. Future explicit zero remains zero.
do $$ begin if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='tenant_usage_limits' and column_name='warning_percent') then
 update public.tenant_usage_limits set voice_minutes_per_month=null where voice_minutes_per_month=0;
end if; end $$;
alter table public.notification_settings add column if not exists translate_owner_answer boolean, add column if not exists behavior jsonb, add column if not exists templates jsonb;
alter table public.tenant_usage_limits add column if not exists warning_percent integer check(warning_percent between 1 and 100);
alter table public.usage_events add column if not exists agent text;
alter table public.escalations add column if not exists pending_since timestamptz, add column if not exists reminded_at timestamptz, add column if not exists closed_at timestamptz;
alter table public.escalations drop constraint if exists escalations_status_check;
alter table public.escalations add constraint escalations_status_check check(status in ('queued','notifying','pending','reminding','delivering','delivered','delivery_uncertain','closing','closed_unanswered'));
update public.escalations set pending_since=created_at where status='pending' and pending_since is null;
do $$ declare p record; begin
 for p in select policyname from pg_policies where schemaname='public' and tablename='usage_events' and cmd in ('INSERT','UPDATE','DELETE','ALL') loop
 execute format('drop policy if exists %I on public.usage_events',p.policyname);
 end loop;
end $$;
-- Preserve once-per-month warning receipts from 025 after renaming the stage.
update public.scheduled_jobs j set payload=jsonb_set(j.payload,'{stage}',to_jsonb(replace(j.payload->>'stage','_80','_warning')))
where j.job_type='usage_limit_notice' and j.payload->>'stage' in ('messages_80','voice_80')
and not exists(select 1 from public.scheduled_jobs n where n.tenant_id=j.tenant_id and n.job_type=j.job_type and n.payload->>'month'=j.payload->>'month' and n.payload->>'stage'=replace(j.payload->>'stage','_80','_warning'));
drop function if exists public.admit_tenant_usage(uuid,text,integer,integer,integer,integer,timestamptz);
create or replace function public.admit_tenant_usage(p_tenant_id uuid,p_event_key text,p_messages integer,p_voice_seconds integer,p_default_messages integer,p_default_voice_seconds integer,p_default_warning_percent integer,p_now timestamptz default now())
returns jsonb language plpgsql security invoker set search_path=public as $$
declare z text; m date; message_limit bigint; voice_limit bigint; u public.tenant_monthly_usage; event_id uuid; permitted boolean; stages text[]:='{}'; stage text; warning_percent integer;
begin
  if p_messages<0 or p_messages>1 or p_voice_seconds<0 or p_default_messages<0 or p_default_voice_seconds<0 or p_event_key is null or length(p_event_key)=0 then raise exception 'Invalid usage admission'; end if;
  select coalesce(time_zone,'UTC') into z from public.notification_settings where tenant_id=p_tenant_id;
  select coalesce(l.warning_percent,p_default_warning_percent) into warning_percent from public.tenant_usage_limits l where tenant_id=p_tenant_id; warning_percent:=coalesce(warning_percent,p_default_warning_percent);
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
revoke all on function public.admit_tenant_usage(uuid,text,integer,integer,integer,integer,integer,timestamptz) from public,anon,authenticated;
grant execute on function public.admit_tenant_usage(uuid,text,integer,integer,integer,integer,integer,timestamptz) to service_role;


create or replace function public.update_tenant_runtime_settings(p_tenant_id uuid,p_limits jsonb,p_notification jsonb,p_behavior jsonb)
returns void language plpgsql security invoker set search_path=public as $$
begin
 insert into public.notification_settings(tenant_id) values(p_tenant_id) on conflict(tenant_id) do nothing;
 update public.notification_settings set
 behavior=coalesce(behavior,'{}'::jsonb)||p_behavior,
 translate_owner_answer=case when p_notification?'translate_owner_answer' then (p_notification->>'translate_owner_answer')::boolean else translate_owner_answer end,
 auto_replies_paused=case when p_notification?'auto_replies_paused' then (p_notification->>'auto_replies_paused')::boolean else auto_replies_paused end,
 time_zone=coalesce(p_notification->>'time_zone',time_zone),
 quiet_hours_start=case when p_notification?'quiet_hours_start' then (p_notification->>'quiet_hours_start')::time else quiet_hours_start end,
 quiet_hours_end=case when p_notification?'quiet_hours_end' then (p_notification->>'quiet_hours_end')::time else quiet_hours_end end,
 templates=case when p_notification?'templates' then p_notification->'templates' else templates end
 where tenant_id=p_tenant_id;
 insert into public.tenant_usage_limits(tenant_id) values(p_tenant_id) on conflict(tenant_id) do nothing;
 update public.tenant_usage_limits set messages_per_month=case when p_limits?'messages_per_month' then (p_limits->>'messages_per_month')::integer else messages_per_month end,
 voice_minutes_per_month=case when p_limits?'voice_minutes_per_month' then (p_limits->>'voice_minutes_per_month')::integer else voice_minutes_per_month end,
 warning_percent=case when p_limits?'warning_percent' then (p_limits->>'warning_percent')::integer else warning_percent end, updated_at=now() where tenant_id=p_tenant_id;
end $$;
revoke all on function public.update_tenant_runtime_settings(uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.update_tenant_runtime_settings(uuid,jsonb,jsonb,jsonb) to service_role;
create or replace function public.tenant_usage_summary(p_tenant_id uuid,p_default_messages integer,p_default_voice_seconds integer,p_now timestamptz default now())
returns jsonb language plpgsql security invoker set search_path=public as $$
declare z text;m date;start_at timestamptz;end_at timestamptz;ml bigint;vl bigint;u public.tenant_monthly_usage;events jsonb;
begin
  select coalesce(time_zone,'UTC') into z from public.notification_settings where tenant_id=p_tenant_id;z:=coalesce(z,'UTC');
  m:=date_trunc('month',timezone(z,p_now))::date;start_at:=m::timestamp at time zone z;end_at:=(m+interval '1 month')::timestamp at time zone z;
  select coalesce(messages_per_month,p_default_messages),coalesce(voice_minutes_per_month::bigint*60,p_default_voice_seconds) into ml,vl from public.tenant_usage_limits where tenant_id=p_tenant_id;
  select * into u from public.tenant_monthly_usage where tenant_id=p_tenant_id and month=m;
  select jsonb_build_object('incoming_messages',coalesce(sum(quantity)filter(where event_type='message_received'),0),'outgoing_messages',coalesce(sum(quantity)filter(where event_type='message_sent'),0),'stt_calls',coalesce(sum(quantity)filter(where event_type='stt_call'),0),'model_calls',coalesce(sum(quantity)filter(where event_type='model_call'),0),'voice_seconds_received',coalesce(sum(quantity)filter(where event_type='voice_received'),0),'input_tokens',coalesce(sum((metadata->>'input_tokens')::bigint)filter(where event_type='model_call'),0),'output_tokens',coalesce(sum((metadata->>'output_tokens')::bigint)filter(where event_type='model_call'),0),'thinking_tokens',coalesce(sum((metadata->>'thinking_tokens')::bigint)filter(where event_type='model_call'),0),'cached_input_tokens',coalesce(sum((metadata->>'cached_input_tokens')::bigint)filter(where event_type='model_call'),0),'total_tokens',coalesce(sum((metadata->>'total_tokens')::bigint)filter(where event_type='model_call'),0),'calls_without_token_usage',count(*)filter(where event_type='model_call' and not(metadata ? 'total_tokens'))) into events
  from public.usage_events where tenant_id=p_tenant_id and created_at>=start_at and created_at<end_at;
  return jsonb_build_object('month',m,'time_zone',z,'period_start',start_at,'period_end',end_at,'messages_used',coalesce(u.messages_used,0),'messages_limit',coalesce(ml,p_default_messages),'voice_seconds_used',coalesce(u.voice_seconds_used,0),'voice_minutes_used',coalesce(u.voice_seconds_used,0)/60.0,'voice_minutes_limit',coalesce(vl,p_default_voice_seconds)/60.0,'events',events);
end $$;
revoke all on function public.tenant_usage_summary(uuid,integer,integer,timestamptz) from public,anon,authenticated;
grant execute on function public.tenant_usage_summary(uuid,integer,integer,timestamptz) to service_role;
commit;
