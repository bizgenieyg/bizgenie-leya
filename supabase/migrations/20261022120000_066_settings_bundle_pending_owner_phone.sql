-- Z9 «Настройки»: one save for every changed owner setting, and a new owner number that waits for confirmation.
begin;

-- The number being confirmed. Questions and requests keep going to owner_phone / owner_chat_id until the owner
-- replies with the code from the new number; then the pending number replaces the old one.
alter table public.notification_settings add column if not exists pending_owner_phone text;

-- One transaction over tenants, assistant_profiles and notification_settings: either every changed setting is
-- saved or none. A key that is absent stays as it is; quiet hours accept an explicit null («Не беспокоить» off).
create or replace function public.save_tenant_settings_bundle(
  p_tenant_id uuid,p_tenant jsonb,p_assistant jsonb,p_notification jsonb,p_behavior jsonb,p_default_time_zone text
) returns void language plpgsql security invoker set search_path=public as $$
begin
  if p_tenant<>'{}'::jsonb then
    update public.tenants set
      business_name=case when p_tenant?'business_name' then p_tenant->>'business_name' else business_name end,
      name=case when p_tenant?'name' then p_tenant->>'name' else name end,
      business_sector=case when p_tenant?'business_sector' then nullif(p_tenant->>'business_sector','') else business_sector end
    where id=p_tenant_id;
    if not found then raise exception 'Tenant not found' using errcode='P0002'; end if;
  end if;
  if p_assistant?'assistant_name' then
    update public.assistant_profiles set assistant_name=p_assistant->>'assistant_name' where tenant_id=p_tenant_id;
    if not found then raise exception 'Assistant profile not found' using errcode='P0002'; end if;
  end if;
  if p_notification<>'{}'::jsonb or p_behavior<>'{}'::jsonb then
    insert into public.notification_settings(tenant_id,time_zone) values(p_tenant_id,p_default_time_zone)
    on conflict(tenant_id) do nothing;
    update public.notification_settings set
      behavior=coalesce(behavior,'{}'::jsonb)||p_behavior,
      translate_owner_answer=case when p_notification?'translate_owner_answer' then (p_notification->>'translate_owner_answer')::boolean else translate_owner_answer end,
      auto_replies_paused=case when p_notification?'auto_replies_paused' then (p_notification->>'auto_replies_paused')::boolean else auto_replies_paused end,
      time_zone=coalesce(p_notification->>'time_zone',time_zone),
      quiet_hours_start=case when p_notification?'quiet_hours_start' then (p_notification->>'quiet_hours_start')::time else quiet_hours_start end,
      quiet_hours_end=case when p_notification?'quiet_hours_end' then (p_notification->>'quiet_hours_end')::time else quiet_hours_end end,
      templates=case when p_notification?'templates' then p_notification->'templates' else templates end
    where tenant_id=p_tenant_id;
  end if;
end $$;
revoke all on function public.save_tenant_settings_bundle(uuid,jsonb,jsonb,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.save_tenant_settings_bundle(uuid,jsonb,jsonb,jsonb,jsonb,text) to service_role;

commit;
