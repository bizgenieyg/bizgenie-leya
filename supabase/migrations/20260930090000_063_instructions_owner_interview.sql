-- 063 (task Z): answers by a business instruction, demo mode in the conversation, owner interview
-- (questions to the owner about missing data), a scheduled job for it.
begin;

-- Business instructions (tenant) and demo-business texts (tenant_id null, demo_key). Versions; one active each.
create table if not exists public.assistant_instructions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,
  kind text not null check (kind in ('business','demo')),
  demo_key text check (demo_key is null or demo_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  version integer not null check (version > 0),
  content text not null check (length(btrim(content)) between 1 and 50000),
  status text not null default 'draft' check (status in ('draft','active','archived')),
  created_by text not null default 'operator' check (length(created_by) between 1 and 60),
  created_at timestamptz not null default now(),
  check (kind = 'business' and tenant_id is not null and demo_key is null or kind = 'demo' and tenant_id is null and demo_key is not null)
);
create unique index if not exists assistant_instructions_business_version on public.assistant_instructions(tenant_id, version) where kind = 'business';
create unique index if not exists assistant_instructions_demo_version on public.assistant_instructions(demo_key, version) where kind = 'demo';
create unique index if not exists assistant_instructions_one_active_business on public.assistant_instructions(tenant_id) where kind = 'business' and status = 'active';
create unique index if not exists assistant_instructions_one_active_demo on public.assistant_instructions(demo_key) where kind = 'demo' and status = 'active';

alter table public.assistant_instructions enable row level security;
drop policy if exists assistant_instructions_select_members on public.assistant_instructions;
-- Members read their own business instruction; demo texts and all writes are service-only.
create policy assistant_instructions_select_members on public.assistant_instructions for select to authenticated using (
  kind = 'business' and exists(select 1 from public.tenant_users tu where tu.tenant_id = assistant_instructions.tenant_id and tu.user_id = (select auth.uid()))
);
grant select on public.assistant_instructions to authenticated;
grant select, insert, update, delete on public.assistant_instructions to service_role;

-- Demo mode ("покажу на примере") lives on the conversation; it closes after demo_max_turns client turns.
alter table public.conversations add column if not exists demo_key text check (demo_key is null or length(demo_key) between 1 and 40);
alter table public.conversations add column if not exists demo_turns integer not null default 0 check (demo_turns >= 0);
alter table public.simulator_sessions add column if not exists demo_key text check (demo_key is null or length(demo_key) between 1 and 40);
alter table public.simulator_sessions add column if not exists demo_turns integer not null default 0 check (demo_turns >= 0);

-- Owner interview: questions about missing data, asked one at a time in WhatsApp and shown as cabinet cards.
-- A separate table, not knowledge_audit_items: these carry a priority, WhatsApp delivery, postponing and
-- a source (operator list or a sector gap); audit cards are wording suggestions decided in the cabinet only.
create table if not exists public.owner_questions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  question text not null check (length(btrim(question)) between 1 and 500),
  priority text not null default 'normal' check (priority in ('launch','normal')),
  source text not null check (source in ('operator','gap')),
  topic text check (topic is null or length(topic) between 1 and 40),
  status text not null default 'open' check (status in ('open','sent','answered','cabinet_only','dropped')),
  postponed_count integer not null default 0 check (postponed_count >= 0),
  next_at timestamptz,
  sent_at timestamptz,
  owner_message_ids text[] not null default '{}',
  answer_source_id uuid references public.knowledge_sources(id) on delete set null,
  created_at timestamptz not null default now(),
  answered_at timestamptz
);
create unique index if not exists owner_questions_unique_text on public.owner_questions(tenant_id, lower(btrim(question)));
create index if not exists owner_questions_queue on public.owner_questions(tenant_id, priority, created_at) where status in ('open','sent');

alter table public.owner_questions enable row level security;
drop policy if exists owner_questions_select_members on public.owner_questions;
create policy owner_questions_select_members on public.owner_questions for select to authenticated using (
  exists(select 1 from public.tenant_users tu where tu.tenant_id = owner_questions.tenant_id and tu.user_id = (select auth.uid()))
);
drop policy if exists owner_questions_write_admins on public.owner_questions;
create policy owner_questions_write_admins on public.owner_questions for all to authenticated using (
  exists(select 1 from public.tenant_users tu where tu.tenant_id = owner_questions.tenant_id and tu.user_id = (select auth.uid()) and tu.role in ('owner','admin'))
) with check (
  exists(select 1 from public.tenant_users tu where tu.tenant_id = owner_questions.tenant_id and tu.user_id = (select auth.uid()) and tu.role in ('owner','admin'))
);
grant select, insert, update, delete on public.owner_questions to authenticated;
grant select, insert, update, delete on public.owner_questions to service_role;

-- A scheduled job per tenant sends the next interview question.
alter table public.scheduled_jobs drop constraint if exists scheduled_jobs_job_type_check;
alter table public.scheduled_jobs add constraint scheduled_jobs_job_type_check
  check (job_type in (
    'owner_escalation', 'escalation_timeout', 'owner_summary',
    'usage_limit_notice', 'weekly_report', 'retention_sweep', 'owner_interview'
  ));
drop index if exists public.scheduled_jobs_next_pending_idx;
create index scheduled_jobs_next_pending_idx
  on public.scheduled_jobs (scheduled_at, id)
  where status in ('pending', 'sending')
    and job_type in ('owner_escalation', 'escalation_timeout', 'owner_summary', 'retention_sweep', 'owner_interview');
create unique index if not exists scheduled_jobs_one_owner_interview_idx
  on public.scheduled_jobs (tenant_id)
  where job_type = 'owner_interview' and status in ('pending', 'sending');

commit;
