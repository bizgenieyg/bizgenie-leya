begin;

alter table public.scheduled_jobs drop constraint scheduled_jobs_job_type_check;
alter table public.scheduled_jobs add constraint scheduled_jobs_job_type_check
  check (job_type in (
    'owner_escalation', 'escalation_timeout', 'owner_summary',
    'usage_limit_notice', 'weekly_report', 'retention_sweep'
  ));

create index scheduled_jobs_next_pending_idx
  on public.scheduled_jobs (scheduled_at, id)
  where status in ('pending', 'sending')
    and job_type in ('owner_escalation', 'escalation_timeout', 'owner_summary', 'retention_sweep');

create unique index scheduled_jobs_one_retention_sweep_idx
  on public.scheduled_jobs (job_type)
  where job_type = 'retention_sweep' and status in ('pending', 'sending');

create unique index scheduled_jobs_one_escalation_timeout_idx
  on public.scheduled_jobs (tenant_id, (payload->>'escalation_id'))
  where job_type = 'escalation_timeout' and status in ('pending', 'sending');

update public.notification_settings
  set behavior = behavior - 'scheduler_interval_seconds'
  where behavior ? 'scheduler_interval_seconds';

commit;
