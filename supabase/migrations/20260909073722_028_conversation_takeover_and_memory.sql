begin;

alter table public.conversations
  add column if not exists owner_last_activity_at timestamptz,
  add column if not exists assistant_introduced_at timestamptz;

alter table public.escalations drop constraint if exists escalations_status_check;
alter table public.escalations add constraint escalations_status_check check(status in (
  'queued','notifying','pending','reminding','delivering','delivered','delivery_uncertain',
  'closing','closed_unanswered','resolved_by_owner','expired'
));

grant select(owner_last_activity_at,assistant_introduced_at) on public.conversations to authenticated;

commit;
