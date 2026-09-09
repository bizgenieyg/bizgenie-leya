begin;

-- Task 3: these tables have RLS enabled with no policies (deny-all for tenant clients),
-- but still carry Supabase's default broad anon/authenticated table grants. Every one is
-- backend-only in Phase 1 — reached solely through the service_role backend, never the
-- browser client. Strip the API-role grants so privileges match intent and the audit
-- finding clears. RLS remains the row guard; this is defence in depth.
--
--   onboarding_sessions  backend-only — holds setup-token hashes; onboarding writes via service_role
--   promises             backend-only — Phase 2 stub, "no Phase 1 application logic"
--   reminders            backend-only — Phase 2 stub
--   services             backend-only for Phase 1 — no tenant catalogue UI yet; when one ships it
--                        will need tenant SELECT + owner/admin write policies plus a grant
--   subscription_addons  backend-only — billing, operator-managed
--   subscriptions        backend-only — billing, operator-managed
--   system_logs          backend-only — observability; logSystemEvent writes via service_role
--   whatsapp_instances   backend-only — stores encrypted WAHA api key / webhook secret; must never be client-readable
--   work_items           backend-only — Phase 2 stub
revoke all on table
  public.onboarding_sessions,
  public.promises,
  public.reminders,
  public.services,
  public.subscription_addons,
  public.subscriptions,
  public.system_logs,
  public.whatsapp_instances,
  public.work_items
from anon, authenticated;

grant all on table
  public.onboarding_sessions,
  public.promises,
  public.reminders,
  public.services,
  public.subscription_addons,
  public.subscriptions,
  public.system_logs,
  public.whatsapp_instances,
  public.work_items
to service_role;

-- Task 2: rls_auto_enable() is a SECURITY DEFINER function behind an event trigger. It is
-- not defined in any tracked migration (it exists only in the live database), so revoke
-- defensively if present. An event trigger fires through the event mechanism with the
-- function's DEFINER rights and does not consult EXECUTE grants, so the trigger keeps
-- working; this only removes the ability to call the function directly as an API role.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end $$;

commit;
