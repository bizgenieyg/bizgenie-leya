begin;

-- Prerequisites: backend schema 001 (including nullable tenants.phone from 004),
-- and 022_tenant_users.sql. Apply with the same verified process used for 022.
create or replace function public.create_tenant_with_owner(
  p_name text,
  p_plan text,
  p_business_name text,
  p_language text,
  p_status text,
  p_trial_ends_at timestamptz
) returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_name is null or btrim(p_name) = ''
     or p_business_name is null or btrim(p_business_name) = '' then
    raise exception 'Name and business name are required' using errcode = '22023';
  end if;
  if p_plan is null or p_plan not in ('starter', 'pro', 'trial')
     or p_language is null or p_language not in ('he', 'ru', 'en') then
    raise exception 'Invalid plan or language' using errcode = '22023';
  end if;
  if p_status is distinct from (case when p_plan = 'trial' then 'trial' else 'active' end)
     or (p_plan = 'trial' and p_trial_ends_at is null)
     or (p_plan <> 'trial' and p_trial_ends_at is not null) then
    raise exception 'Invalid trial settings' using errcode = '22023';
  end if;

  insert into public.tenants (name, business_name, language, tier, status, trial_ends_at)
  values (btrim(p_name), btrim(p_business_name), p_language, p_plan, p_status, p_trial_ends_at)
  returning id into v_tenant_id;

  insert into public.tenant_users (tenant_id, user_id, role)
  values (v_tenant_id, v_user_id, 'owner');

  -- Step 1 only supplied tenant_id; all profile fields keep database defaults.
  insert into public.assistant_profiles (tenant_id) values (v_tenant_id);

  -- Preserve the three existing step-1 module settings in the same transaction.
  insert into public.module_settings (tenant_id, module_name, enabled, limits)
  values
    (v_tenant_id, 'knowledge', true, '{}'::jsonb),
    (v_tenant_id, 'escalation', true, '{}'::jsonb),
    (v_tenant_id, 'reports', true, '{"report_frequency":"weekly"}'::jsonb);

  return v_tenant_id;
end;
$function$;

revoke all on function public.create_tenant_with_owner(text, text, text, text, text, timestamptz) from public, anon;
grant execute on function public.create_tenant_with_owner(text, text, text, text, text, timestamptz) to authenticated;

-- Remove the old bootstrap escape hatches from backend migration 004.
-- Clients must not forge membership or promote themselves to owner/admin.
drop policy if exists "Authenticated users can create tenants" on public.tenants;
drop policy if exists "Users can create own tenant links" on public.tenant_users;
revoke insert, update, delete on public.tenant_users from anon, authenticated;

-- Replace every write policy from 022, and cover tenants using its id column.
-- SELECT policies are intentionally untouched. Restrictive guards also prevent
-- any other permissive write policy from bypassing the owner/admin requirement.
do $migration$
declare
  table_name text;
  policy_prefix text;
  tenant_column text;
  predicate text;
  insert_predicate text;
  policy_name text;
begin
  for table_name, policy_prefix, tenant_column in
    select * from (values
      ('assistant_profiles', 'assistant profiles', 'tenant_id'),
      ('clients', 'clients', 'tenant_id'),
      ('client_profiles', 'client profiles', 'tenant_id'),
      ('conversations', 'conversations', 'tenant_id'),
      ('messages', 'messages', 'tenant_id'),
      ('knowledge_items', 'knowledge items', 'tenant_id'),
      ('module_settings', 'module settings', 'tenant_id'),
      ('usage_events', 'usage events', 'tenant_id'),
      ('agent_actions', 'agent actions', 'tenant_id'),
      ('scheduled_jobs', 'scheduled jobs', 'tenant_id'),
      ('tenants', 'tenants', 'id')
    ) as tables(table_name, policy_prefix, tenant_column)
  loop
    execute format('alter table public.%I enable row level security', table_name);
    predicate := format(
      '%I in (select tenant_id from public.tenant_users where user_id = (select auth.uid()) and role in (''owner'', ''admin''))',
      tenant_column
    );
    -- No direct tenant INSERT, even by an owner. Only the definer RPC creates it.
    insert_predicate := case when table_name = 'tenants' then 'false and (' || predicate || ')' else predicate end;

    policy_name := 'Tenant members can INSERT ' || policy_prefix;
    execute format('drop policy if exists %I on public.%I', policy_name, table_name);
    execute format('create policy %I on public.%I for insert to authenticated with check (%s)', policy_name, table_name, insert_predicate);
    policy_name := 'Tenant members can UPDATE ' || policy_prefix;
    execute format('drop policy if exists %I on public.%I', policy_name, table_name);
    execute format('create policy %I on public.%I for update to authenticated using (%s) with check (%s)', policy_name, table_name, predicate, predicate);
    policy_name := 'Tenant members can DELETE ' || policy_prefix;
    execute format('drop policy if exists %I on public.%I', policy_name, table_name);
    execute format('create policy %I on public.%I for delete to authenticated using (%s)', policy_name, table_name, predicate);

    policy_name := 'Tenant role guard INSERT ' || policy_prefix;
    execute format('drop policy if exists %I on public.%I', policy_name, table_name);
    execute format('create policy %I on public.%I as restrictive for insert to public with check (%s)', policy_name, table_name, insert_predicate);
    policy_name := 'Tenant role guard UPDATE ' || policy_prefix;
    execute format('drop policy if exists %I on public.%I', policy_name, table_name);
    execute format('create policy %I on public.%I as restrictive for update to public using (%s) with check (%s)', policy_name, table_name, predicate, predicate);
    policy_name := 'Tenant role guard DELETE ' || policy_prefix;
    execute format('drop policy if exists %I on public.%I', policy_name, table_name);
    execute format('create policy %I on public.%I as restrictive for delete to public using (%s)', policy_name, table_name, predicate);
  end loop;
end;
$migration$;

commit;
