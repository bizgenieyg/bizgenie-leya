-- 061: "What Leya knows" (task R). Short business facts by topic, each traced to its source with a
-- verbatim quote; sources of any kind; audit cards; assistant rules and examples (filled in S/T).
-- Topics are a code enum (no check here) so a topic is added without a migration.
-- Existing knowledge_documents stay as they are: a source links to its document (document_id);
-- files in Storage and chunks are not touched. Old knowledge_items are kept for rollback.
begin;

create table if not exists public.knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null check (kind in ('text','file','link','photo','voice','owner_answer','correction','onboarding','migration')),
  title text check (title is null or length(title) <= 300),
  original_text text check (original_text is null or length(original_text) <= 200000),
  url text check (url is null or length(url) <= 2000),
  storage_path text check (storage_path is null or length(storage_path) <= 1000),
  document_id uuid references public.knowledge_documents(id) on delete set null,
  status text not null default 'processing' check (status in ('processing','ready','failed')),
  error text check (error is null or length(error) <= 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists knowledge_sources_tenant_created on public.knowledge_sources(tenant_id, created_at desc);

create table if not exists public.business_facts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  topic text not null check (length(topic) between 1 and 40),
  text text not null check (length(btrim(text)) between 1 and 500),
  source_id uuid references public.knowledge_sources(id) on delete set null,
  quote text check (quote is null or length(quote) <= 500),
  status text not null default 'draft' check (status in ('draft','active','archived')),
  supersedes_id uuid references public.business_facts(id) on delete set null,
  created_by text not null check (created_by in ('extract','owner','correction','onboarding','migration','audit')),
  embedding extensions.vector(768),
  embedding_model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists business_facts_active_topic on public.business_facts(tenant_id, topic) where status = 'active';
create index if not exists business_facts_source on public.business_facts(tenant_id, source_id);

-- Audit and gap cards ("Было / Предлагаем / почему", or a question to the owner). A separate table,
-- not knowledge_suggestions: those are owner answers offered in the WhatsApp summary (question and
-- answer required, one per escalation); cards have no escalation and are decided in the cabinet.
create table if not exists public.knowledge_audit_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null check (kind in ('audit','gap')),
  check_type text not null check (check_type in ('jargon','no_benefit','scary','no_price','objection','next_step','contradiction','conflict')),
  topic text not null check (length(topic) between 1 and 40),
  fact_id uuid references public.business_facts(id) on delete cascade,
  -- Text of the fact when the card was made: a skipped card is not offered again until the fact changes.
  fact_fingerprint text,
  before_text text check (before_text is null or length(before_text) <= 500),
  suggested_text text check (suggested_text is null or length(suggested_text) <= 500),
  question text check (question is null or length(question) <= 500),
  reason text check (reason is null or length(reason) <= 300),
  status text not null default 'open' check (status in ('open','accepted','edited','skipped','answered','dropped')),
  resolved_fact_id uuid references public.business_facts(id) on delete set null,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  check (kind = 'gap' and question is not null or kind = 'audit' and suggested_text is not null)
);
create index if not exists knowledge_audit_open on public.knowledge_audit_items(tenant_id, created_at) where status = 'open';

create table if not exists public.assistant_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  text text not null check (length(btrim(text)) between 1 and 300),
  source text not null default 'owner' check (length(source) between 1 and 40),
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now()
);
create index if not exists assistant_rules_active on public.assistant_rules(tenant_id) where status = 'active';

create table if not exists public.assistant_examples (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  client_text text not null check (length(btrim(client_text)) between 1 and 1000),
  reply_text text not null check (length(btrim(reply_text)) between 1 and 1000),
  source text not null default 'owner' check (length(source) between 1 and 40),
  status text not null default 'active' check (status in ('active','archived')),
  -- Embedding of client_text: the 3 examples nearest to the client's message go into the prompt.
  embedding extensions.vector(768),
  embedding_model text,
  created_at timestamptz not null default now()
);
create index if not exists assistant_examples_active on public.assistant_examples(tenant_id) where status = 'active';

-- At most 20 active rules and 10 active examples per tenant, whoever writes.
create or replace function public.enforce_assistant_limits() returns trigger language plpgsql set search_path = public as $$
declare active_count integer; max_count integer := case tg_table_name when 'assistant_rules' then 20 else 10 end;
begin
  if new.status <> 'active' then return new; end if;
  execute format('select count(*) from public.%I where tenant_id = $1 and status = ''active'' and id <> $2', tg_table_name)
    into active_count using new.tenant_id, new.id;
  if active_count >= max_count then raise exception 'assistant_limit_reached' using errcode = '23514'; end if;
  return new;
end $$;
drop trigger if exists assistant_rules_limit on public.assistant_rules;
create trigger assistant_rules_limit before insert or update of status on public.assistant_rules for each row execute function public.enforce_assistant_limits();
drop trigger if exists assistant_examples_limit on public.assistant_examples;
create trigger assistant_examples_limit before insert or update of status on public.assistant_examples for each row execute function public.enforce_assistant_limits();

-- RLS as for the neighbouring tenant tables: members read, owner/admin write.
do $$
declare t text;
begin
  foreach t in array array['knowledge_sources','business_facts','knowledge_audit_items','assistant_rules','assistant_examples'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select_members', t);
    execute format('create policy %I on public.%I for select to authenticated using (exists(select 1 from public.tenant_users tu where tu.tenant_id=%I.tenant_id and tu.user_id=(select auth.uid())))', t || '_select_members', t, t);
    execute format('drop policy if exists %I on public.%I', t || '_write_admins', t);
    execute format('create policy %I on public.%I for all to authenticated using (exists(select 1 from public.tenant_users tu where tu.tenant_id=%I.tenant_id and tu.user_id=(select auth.uid()) and tu.role in (''owner'',''admin''))) with check (exists(select 1 from public.tenant_users tu where tu.tenant_id=%I.tenant_id and tu.user_id=(select auth.uid()) and tu.role in (''owner'',''admin'')))', t || '_write_admins', t, t, t);
    execute format('grant select,insert,update,delete on public.%I to authenticated', t);
    execute format('grant select,insert,update,delete on public.%I to service_role', t);
  end loop;
end $$;

-- An accepted owner answer becomes a fact of this topic (instead of a Q&A pair in knowledge_mode='facts').
alter table public.knowledge_suggestions add column if not exists topic text check (topic is null or length(topic) between 1 and 40);
alter table public.knowledge_suggestions add column if not exists fact_text text check (fact_text is null or length(fact_text) <= 500);
alter table public.knowledge_suggestions add column if not exists fact_id uuid references public.business_facts(id) on delete set null;

-- Nearest active facts of a tenant (answer context in knowledge_mode='facts').
create or replace function public.match_business_facts(
  p_tenant_id uuid,
  p_embedding extensions.vector(768),
  p_embedding_model text,
  p_limit integer
) returns table(id uuid, topic text, text text, similarity double precision)
language sql stable security invoker set search_path = public, extensions as $$
  select f.id, f.topic, f.text, 1 - (f.embedding <=> p_embedding) as similarity
  from public.business_facts f
  where f.tenant_id = p_tenant_id and f.status = 'active' and f.embedding is not null and f.embedding_model = p_embedding_model
  order by f.embedding <=> p_embedding
  limit greatest(1, least(p_limit, 50));
$$;
grant execute on function public.match_business_facts(uuid, extensions.vector, text, integer) to authenticated, service_role;

commit;
