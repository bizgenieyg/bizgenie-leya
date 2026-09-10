begin;

-- Apply this ONLY after the onboarding app (Vercel) has been redeployed and every live
-- build calls the 3-arg create_tenant_with_owner. This removes the 6-arg compatibility
-- shim introduced in migration 034. Shared numbering with backend (bizgenie-leya): 035.
drop function if exists public.create_tenant_with_owner(text, text, text, text, text, timestamptz);

commit;

