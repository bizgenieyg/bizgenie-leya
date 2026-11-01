-- Z15: «Нужен ответ» as the owner's one entry point.
-- 1. A proposal can also be a setting change («Было → станет. Сохранить?»), a request to BizGenie («Передать в BizGenie?»)
--    or a question with options 1/2/3; what it carries is in payload. A setting or a request, once done, is 'applied'
--    (not 'confirmed': «отмени последнее» turns back rules and facts only).
alter table public.owner_rule_proposals drop constraint if exists owner_rule_proposals_action_check;
alter table public.owner_rule_proposals add constraint owner_rule_proposals_action_check
  check (action in ('add','edit','remove','fact','fact_rule','setting','support','choice'));
alter table public.owner_rule_proposals drop constraint if exists owner_rule_proposals_status_check;
alter table public.owner_rule_proposals add constraint owner_rule_proposals_status_check
  check (status in ('details','pending','confirmed','declined','superseded','undone','applied'));
alter table public.owner_rule_proposals add column if not exists payload jsonb;

-- 2. Requests of owners to BizGenie. The operator answers by a quote in the support group; the answer goes to the owner
--    («Ответ BizGenie: …»), and the owner's quote of that answer goes back to the same request. Service only.
create table if not exists public.support_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  text text not null check (length(text) between 1 and 2000),
  -- The quoted message (an answer of the assistant to a client) and its dialog, when the owner wrote by a quote.
  quoted_text text check (quoted_text is null or length(quoted_text) <= 2000),
  conversation_id uuid references public.conversations(id) on delete set null,
  status text not null default 'new' check (status in ('new','answered','closed')),
  -- Messages to the operator (outbound row ids and WhatsApp ids) and to the owner — a quote of any finds the request.
  operator_message_ids text[] not null default '{}',
  owner_message_ids text[] not null default '{}',
  answer text,
  created_at timestamptz not null default now(),
  answered_at timestamptz
);
create index if not exists support_requests_tenant_idx on public.support_requests(tenant_id, created_at desc);
create index if not exists support_requests_operator_idx on public.support_requests using gin(operator_message_ids);
create index if not exists support_requests_owner_idx on public.support_requests using gin(owner_message_ids);
alter table public.support_requests enable row level security;
revoke all on public.support_requests from anon, authenticated;
grant select,insert,update,delete on public.support_requests to service_role;

-- 3. The hint («Можно писать обычными словами …») goes once to every «Нужен ответ» group, also to those created before Z15.
alter table public.owner_channels add column if not exists hint_sent_at timestamptz;
