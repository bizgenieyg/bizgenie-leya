-- 069 (Z12): the owner cycle as in chef-bot. A request carries the card the model wrote for the owner; reminders
-- are counted (at most escalation_remind_max); the daily report is sent once per tenant and day; the nightly review
-- keeps doubtful replies for the operator (quality_findings, service only, no client names or phones).
begin;

alter table public.escalations add column if not exists owner_card text check (owner_card is null or length(owner_card) <= 2000);
alter table public.escalations add column if not exists reminder_count integer not null default 0;
-- The client said goodbye before the owner answered: the answer is kept as a fact, not forwarded.
alter table public.escalations drop constraint if exists escalations_status_check;
alter table public.escalations add constraint escalations_status_check check(status in (
  'queued','notifying','pending','reminding','delivering','answered','delivered','delivery_uncertain',
  'closing','closed_unanswered','resolved_by_owner','expired','client_left'
));

-- A message that quotes another (a reminder replies to the original question; WAHA sendText reply_to).
alter table public.outbound_messages add column if not exists reply_to text check (reply_to is null or length(reply_to) <= 300);

-- One daily report per tenant and day (the day the report is about, in the tenant's zone).
create table if not exists public.owner_daily_reports (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  report_date date not null,
  conversations integer not null default 0,
  -- A claim is a lease: a failed or crashed review is tried again next hour, at most daily_report_max_attempts times.
  attempts integer not null default 1,
  claimed_at timestamptz not null default now(),
  sent_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (tenant_id, report_date)
);
alter table public.owner_daily_reports enable row level security;
revoke all on public.owner_daily_reports from anon, authenticated;
grant select,insert,update,delete on public.owner_daily_reports to service_role;

-- Doubtful replies found by the nightly review. Service only: the operator reads them; reported_at — sent in the
-- daily operator message.
create table if not exists public.quality_findings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  report_date date not null,
  kind text not null check (kind in ('price_not_in_facts','term_not_in_facts','promise_for_owner','contradicts_facts','other')),
  reply_excerpt text check (reply_excerpt is null or length(reply_excerpt) <= 500),
  note text check (note is null or length(note) <= 500),
  -- The operator message this finding went in; reported_at is set once that message is confirmed sent.
  report_message_id uuid references public.outbound_messages(id) on delete set null,
  reported_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists quality_findings_unreported_idx on public.quality_findings(created_at) where reported_at is null;
alter table public.quality_findings enable row level security;
revoke all on public.quality_findings from anon, authenticated;
grant select,insert,update,delete on public.quality_findings to service_role;

-- The daily report job (one, system-wide, like the retention sweep).
alter table public.scheduled_jobs drop constraint if exists scheduled_jobs_job_type_check;
alter table public.scheduled_jobs add constraint scheduled_jobs_job_type_check
  check (job_type in (
    'owner_escalation', 'escalation_timeout', 'owner_summary',
    'usage_limit_notice', 'weekly_report', 'retention_sweep', 'owner_interview', 'daily_report'
  ));
drop index if exists public.scheduled_jobs_next_pending_idx;
create index scheduled_jobs_next_pending_idx
  on public.scheduled_jobs (scheduled_at, id)
  where status in ('pending', 'sending')
    and job_type in ('owner_escalation', 'escalation_timeout', 'owner_summary', 'retention_sweep', 'owner_interview', 'daily_report');

commit;
