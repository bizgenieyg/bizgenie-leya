-- 057: one escalation per client question (batches), knowledge suggestions from owner answers,
-- real client phone numbers (lid ids are never a phone).
begin;

-- Escalation batches: several questions from one inbound batch, answered together.
alter table public.escalations add column if not exists batch_id uuid;
alter table public.escalations add column if not exists batch_position integer not null default 0;
drop index if exists public.escalation_inbound_unique;
create unique index if not exists escalation_inbound_position_unique
  on public.escalations(tenant_id, inbound_id, batch_position) where inbound_id is not null;
create index if not exists escalation_batch_idx on public.escalations(tenant_id, batch_id) where batch_id is not null;
alter table public.escalations drop constraint if exists escalations_status_check;
alter table public.escalations add constraint escalations_status_check check(status in (
  'queued','notifying','pending','reminding','delivering','answered','delivered','delivery_uncertain',
  'closing','closed_unanswered','resolved_by_owner','expired'
));

-- Knowledge suggestions offered in the owner summary.
create table if not exists public.knowledge_suggestions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  question text not null check (length(question) between 1 and 1000),
  answer text not null check (length(answer) between 1 and 4000),
  source_escalation_id uuid references public.escalations(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','accepted','rejected','expired')),
  offered_in_outbound_id uuid references public.outbound_messages(id) on delete set null,
  offer_position integer,
  offer_count integer not null default 0 check (offer_count >= 0),
  knowledge_item_id uuid references public.knowledge_items(id) on delete set null,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (tenant_id, source_escalation_id)
);
create index if not exists knowledge_suggestions_pending_idx on public.knowledge_suggestions(tenant_id, created_at) where status = 'pending';
create index if not exists knowledge_suggestions_offer_idx on public.knowledge_suggestions(tenant_id, offered_in_outbound_id) where offered_in_outbound_id is not null;

alter table public.knowledge_suggestions enable row level security;
drop policy if exists knowledge_suggestions_select_members on public.knowledge_suggestions;
create policy knowledge_suggestions_select_members on public.knowledge_suggestions for select to authenticated using (
  exists(select 1 from public.tenant_users tu where tu.tenant_id=knowledge_suggestions.tenant_id and tu.user_id=(select auth.uid()))
);
drop policy if exists knowledge_suggestions_write_admins on public.knowledge_suggestions;
create policy knowledge_suggestions_write_admins on public.knowledge_suggestions for all to authenticated using (
  exists(select 1 from public.tenant_users tu where tu.tenant_id=knowledge_suggestions.tenant_id and tu.user_id=(select auth.uid()) and tu.role in ('owner','admin'))
) with check (
  exists(select 1 from public.tenant_users tu where tu.tenant_id=knowledge_suggestions.tenant_id and tu.user_id=(select auth.uid()) and tu.role in ('owner','admin'))
);
grant select,insert,update,delete on public.knowledge_suggestions to authenticated;
grant select,insert,update,delete on public.knowledge_suggestions to service_role;

-- A lid id stored as a phone is not a phone: phone becomes optional and lid values are cleared.
alter table public.clients alter column phone drop not null;
update public.clients set phone = null where phone like '%@%' or phone !~ '^[0-9]{8,15}$';

commit;
