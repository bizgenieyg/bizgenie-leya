begin;

-- Shared numbering with backend (bizgenie-leya): 036. Prerequisites: 034 (system_config +
-- 3-arg create_tenant_with_owner + 6-arg shim). Apply on top of 034; 035 is independent.

-- Security fix (race): 034's create_tenant_with_owner does count(*) -> compare -> insert
-- with nothing serialising two concurrent calls by the same user, so both can read 0 and
-- both insert. Take a transaction-scoped advisory lock keyed on the user id BEFORE the
-- count, so concurrent creations by one account run one at a time; the second then sees
-- the first's row and hits the cap. Chosen over a counter/unique-index because it needs no
-- schema change, is released automatically on commit/rollback, and only serialises the same
-- user (different users hash to different keys, so no cross-user contention).

create or replace function public.create_tenant_with_owner(
  p_name text,
  p_business_name text,
  p_language text
) returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_plan text := coalesce((select value #>> '{}' from public.system_config where key = 'signup_default_plan'), 'starter');
  v_max integer := coalesce((select (value #>> '{}')::integer from public.system_config where key = 'max_tenants_per_owner'), 1);
  v_owned integer;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  -- Serialise concurrent create calls by this user for the rest of the transaction.
  perform pg_advisory_xact_lock(hashtextextended('create_tenant_with_owner:' || v_user_id::text, 0));

  if p_name is null or btrim(p_name) = ''
     or p_business_name is null or btrim(p_business_name) = '' then
    raise exception 'Name and business name are required' using errcode = '22023';
  end if;
  if p_language is null or p_language not in ('he', 'ru', 'en') then
    raise exception 'Invalid language' using errcode = '22023';
  end if;

  -- Per-account cap. Raised with a stable errcode so the client can show a clear message.
  select count(*) into v_owned
  from public.tenant_users
  where user_id = v_user_id and role = 'owner';
  if v_owned >= greatest(v_max, 0) then
    raise exception 'Business limit reached for this account'
      using errcode = '54000', hint = 'max_tenants_per_owner';
  end if;

  insert into public.tenants (name, business_name, language, tier, status, trial_ends_at)
  values (btrim(p_name), btrim(p_business_name), p_language, v_plan, 'active', null)
  returning id into v_tenant_id;

  insert into public.tenant_users (tenant_id, user_id, role)
  values (v_tenant_id, v_user_id, 'owner');

  insert into public.assistant_profiles (tenant_id) values (v_tenant_id);

  insert into public.module_settings (tenant_id, module_name, enabled, limits)
  values
    (v_tenant_id, 'knowledge', true, '{}'::jsonb),
    (v_tenant_id, 'escalation', true, '{}'::jsonb),
    (v_tenant_id, 'reports', true, '{"report_frequency":"weekly"}'::jsonb);

  return v_tenant_id;
end;
$function$;

revoke all on function public.create_tenant_with_owner(text, text, text) from public, anon;
grant execute on function public.create_tenant_with_owner(text, text, text) to authenticated;

commit;
