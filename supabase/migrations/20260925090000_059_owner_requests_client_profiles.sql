-- 059: owner requests (demo, booking, callback…) as escalations of kind 'request';
-- what Leya learned about a client in client_profiles; a separate profile for the simulator.
begin;

alter table public.escalations add column if not exists kind text not null default 'question'
  check (kind in ('question','request'));
-- One open request per client conversation; further messages extend it instead of notifying again.
create unique index if not exists escalation_open_request_unique on public.escalations(tenant_id, conversation_id)
  where kind = 'request' and status in ('queued','notifying','pending','reminding','answered','delivering');

alter table public.client_profiles alter column profile_md set default '';
alter table public.client_profiles add constraint client_profiles_profile_length check (profile_md is null or length(profile_md) <= 2000) not valid;
create unique index if not exists client_profiles_tenant_client on public.client_profiles(tenant_id, client_id);

alter table public.simulator_sessions add column if not exists profile_md text not null default ''
  check (length(profile_md) <= 2000);
alter table public.simulator_sessions add column if not exists open_request text
  check (open_request is null or length(open_request) <= 2000);

commit;
