begin;

insert into public.system_config(key,value)
values('signup_default_time_zone','"Asia/Jerusalem"'::jsonb)
on conflict(key) do nothing;

-- A newly provisioned business must explicitly opt in before any customer-facing
-- automation starts. Keeping this row creation inside the provisioning RPC makes
-- the safe state atomic with the tenant, owner membership, profile and plan.
create or replace function public.create_tenant_with_owner(p_name text,p_business_name text,p_language text)
returns uuid language plpgsql security definer set search_path=public as $function$
declare
  v_user_id uuid:=auth.uid();v_tenant_id uuid;v_plan text;v_time_zone text;v_plan_row public.plans%rowtype;
  v_max integer:=coalesce((select (value#>>'{}')::integer from public.system_config where key='max_tenants_per_owner'),1);v_owned integer;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode='42501';end if;
  perform pg_advisory_xact_lock(hashtextextended('create_tenant_with_owner:'||v_user_id::text,0));
  if p_name is null or btrim(p_name)='' or p_business_name is null or btrim(p_business_name)='' then raise exception 'Name and business name are required' using errcode='22023';end if;
  if p_language is null or p_language not in('he','ru','en') then raise exception 'Invalid language' using errcode='22023';end if;
  select count(*) into v_owned from public.tenant_users where user_id=v_user_id and role='owner';
  if v_owned>=greatest(v_max,0) then raise exception 'Business limit reached for this account' using errcode='54000',hint='max_tenants_per_owner';end if;
  v_plan:=coalesce((select value#>>'{}' from public.system_config where key='signup_default_plan'),'basic');
  v_time_zone:=coalesce((select value#>>'{}' from public.system_config where key='signup_default_time_zone'),'Asia/Jerusalem');
  select * into v_plan_row from public.plans where code=v_plan;
  if not found then raise exception 'Signup plan is not configured' using errcode='55000';end if;
  insert into public.tenants(name,business_name,language,tier,status,trial_ends_at) values(btrim(p_name),btrim(p_business_name),p_language,v_plan,'active',null) returning id into v_tenant_id;
  insert into public.tenant_users(tenant_id,user_id,role)values(v_tenant_id,v_user_id,'owner');
  insert into public.assistant_profiles(tenant_id)values(v_tenant_id);
  insert into public.notification_settings(tenant_id,time_zone,auto_replies_paused)values(v_tenant_id,v_time_zone,true);
  insert into public.module_settings(tenant_id,module_name,enabled,limits)values(v_tenant_id,'knowledge',true,'{}'),(v_tenant_id,'escalation',true,'{}'),(v_tenant_id,'reports',true,'{"report_frequency":"weekly"}');
  perform public.ensure_tenant_usage_limits(v_tenant_id);
  return v_tenant_id;
end;$function$;
revoke all on function public.create_tenant_with_owner(text,text,text) from public,anon;
grant execute on function public.create_tenant_with_owner(text,text,text) to authenticated;

commit;
