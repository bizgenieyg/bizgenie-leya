begin;

-- Numbering: backend (bizgenie-leya) and this repo apply migrations to the SAME Supabase
-- database, so they share ONE integer sequence. Backend is at 033; this is 034. Do not
-- reuse a number that exists in either repo.
--
-- Prerequisites: backend schema 001, this repo's 022_tenant_users.sql and
-- 023_create_tenant_with_owner.sql. Apply with the same verified process used for 022/023.

-- Security fix: 023's create_tenant_with_owner let any authenticated user pick their own
-- plan (starter/pro/trial) and create unlimited tenants — self-service around billing.
-- The plan now comes from system config, never the client, and each account is capped.

-- Operator-only system configuration. No RLS policies => deny-all for anon/authenticated;
-- only the SECURITY DEFINER RPC and the service_role backend read it.
create table if not exists public.system_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.system_config enable row level security;
revoke all on table public.system_config from anon, authenticated;
grant all on table public.system_config to service_role;

insert into public.system_config (key, value) values
  ('signup_default_plan', '"starter"'::jsonb),
  ('max_tenants_per_owner', '1'::jsonb)
on conflict (key) do nothing;

-- New canonical signature: no plan / status / trial from the client.
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

  -- Always the system starter plan. Plan changes are an operator action
  -- (backend PATCH /api/admin/usage-limits with ADMIN_SECRET), never self-service.
  insert into public.tenants (name, business_name, language, tier, status, trial_ends_at)
  values (btrim(p_name), btrim(p_business_name), p_language, v_plan, 'active', null)
  returning id into v_tenant_id;

  insert into public.tenant_users (tenant_id, user_id, role)
  values (v_tenant_id, v_user_id, 'owner');

  -- Step 1 only supplies tenant_id; all profile fields keep database defaults.
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

revoke all on function public.create_tenant_with_owner(text, text, text) from public, anon;
grant execute on function public.create_tenant_with_owner(text, text, text) to authenticated;

-- Deploy-order safety: the onboarding app (Vercel) redeploys AFTER this migration is
-- applied. Until it does, the still-live build calls the old 6-arg signature. Keep that
-- signature as a thin compatibility shim that DISCARDS the client's plan/status/trial and
-- delegates to the new 3-arg version, so both builds work during the window and no plan is
-- ever chosen by the client. Migration 035 drops this shim once the new build is live.
create or replace function public.create_tenant_with_owner(
  p_name text,
  p_plan text,
  p_business_name text,
  p_language text,
  p_status text,
  p_trial_ends_at timestamptz
) returns uuid
language sql
security invoker
set search_path = public
as $function$
  select public.create_tenant_with_owner(p_name, p_business_name, p_language);
$function$;

revoke all on function public.create_tenant_with_owner(text, text, text, text, text, timestamptz) from public, anon;
grant execute on function public.create_tenant_with_owner(text, text, text, text, text, timestamptz) to authenticated;

commit;
