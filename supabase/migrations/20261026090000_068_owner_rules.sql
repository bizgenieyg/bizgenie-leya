-- 068 (Z11): the owner's rules for the assistant, set in WhatsApp («Нужен ответ») or the cabinet. A rule is saved only
-- after the owner confirmed «Поняла так: … Сохранить?»; proposals keep that state and what a change replaced, so
-- «отмени последнее» can turn the last change back.
begin;

create table if not exists public.owner_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  number integer not null check (number > 0),
  text text not null check (length(btrim(text)) between 1 and 300),
  active boolean not null default true,
  source text not null check (source in ('cabinet','whatsapp')),
  confirmed_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, number)
);
create index if not exists owner_rules_active_idx on public.owner_rules(tenant_id, number) where active;

alter table public.owner_rules enable row level security;
-- Members read their rules; changes go only through the backend (understanding → «Сохранить?» → confirm_owner_rule_proposal),
-- so the limit and the confirmation cannot be bypassed by a direct write with the user key.
drop policy if exists owner_rules_select_members on public.owner_rules;
create policy owner_rules_select_members on public.owner_rules for select to authenticated using (
  exists(select 1 from public.tenant_users tu where tu.tenant_id=owner_rules.tenant_id and tu.user_id=(select auth.uid()))
);
revoke insert,update,delete on public.owner_rules from anon, authenticated;
grant select on public.owner_rules to authenticated;
grant select,insert,update,delete on public.owner_rules to service_role;

-- What the assistant understood and asked to confirm. Service only (the cabinet goes through the backend).
create table if not exists public.owner_rule_proposals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  action text not null check (action in ('add','edit','remove','fact','fact_rule')),
  rule_number integer,
  rule_text text check (rule_text is null or length(rule_text) <= 300),
  fact_text text check (fact_text is null or length(fact_text) <= 500),
  fact_topic text,
  -- 'details': the rule needs a fact first («Какие условия у абонемента?»); the owner's next message completes it.
  status text not null default 'pending' check (status in ('details','pending','confirmed','declined','superseded','undone')),
  details_question text,
  source text not null check (source in ('cabinet','whatsapp')),
  message_ids text[] not null default '{}',
  -- After «Да»: what changed, so the last change can be undone.
  rule_id uuid references public.owner_rules(id) on delete set null,
  previous_text text,
  fact_id uuid references public.business_facts(id) on delete set null,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists owner_rule_proposals_open_idx on public.owner_rule_proposals(tenant_id, created_at desc) where status in ('details','pending');
create index if not exists owner_rule_proposals_confirmed_idx on public.owner_rule_proposals(tenant_id, decided_at desc) where status = 'confirmed';
alter table public.owner_rule_proposals enable row level security;
revoke all on public.owner_rule_proposals from anon, authenticated;
grant select,insert,update,delete on public.owner_rule_proposals to service_role;

-- «Да»: the whole change in one transaction. The proposal row is locked and must still be pending (two confirmations
-- of one proposal: the second fails), the rules of the tenant are serialized for the limit and the number, and any
-- error (the limit, a rule gone) rolls everything back — no fact without its rule, the proposal stays pending.
create or replace function public.confirm_owner_rule_proposal(p_tenant_id uuid, p_proposal_id uuid, p_message_id text, p_max_rules integer,
  p_fact_embedding text, p_embedding_model text, p_fact_title text)
returns jsonb language plpgsql security invoker set search_path=public, extensions as $$
declare
  p public.owner_rule_proposals%rowtype; v_rule public.owner_rules%rowtype;
  v_source uuid; v_fact uuid; v_rule_id uuid; v_number integer; v_previous text; v_active integer;
begin
  select * into p from public.owner_rule_proposals where id=p_proposal_id and tenant_id=p_tenant_id for update;
  if not found or p.status<>'pending' then raise exception 'proposal_closed' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('owner_rules:'||p_tenant_id::text,0));
  if p.action in ('add','fact_rule') then
    select count(*) into v_active from public.owner_rules where tenant_id=p_tenant_id and active;
    if v_active>=p_max_rules then raise exception 'rules_full' using errcode='P0001'; end if;
  end if;
  if p.action in ('edit','remove') then
    select * into v_rule from public.owner_rules where tenant_id=p_tenant_id and number=p.rule_number and active for update;
    if not found then raise exception 'rule_not_found' using errcode='P0001'; end if;
  end if;
  if p.action in ('fact','fact_rule') then
    insert into public.knowledge_sources(tenant_id,kind,title,original_text,status) values(p_tenant_id,'owner_answer',p_fact_title,p.fact_text,'ready') returning id into v_source;
    insert into public.business_facts(tenant_id,topic,text,source_id,status,created_by,embedding,embedding_model)
      values(p_tenant_id,coalesce(p.fact_topic,'other'),p.fact_text,v_source,'active','owner',
        case when p_fact_embedding is null then null else p_fact_embedding::extensions.vector end,case when p_fact_embedding is null then null else p_embedding_model end)
      returning id into v_fact;
  end if;
  if p.action in ('add','fact_rule') then
    select coalesce(max(number),0)+1 into v_number from public.owner_rules where tenant_id=p_tenant_id;
    insert into public.owner_rules(tenant_id,number,text,source,confirmed_message_id) values(p_tenant_id,v_number,p.rule_text,p.source,p_message_id) returning id into v_rule_id;
  elsif p.action='edit' then
    v_rule_id:=v_rule.id; v_number:=v_rule.number; v_previous:=v_rule.text;
    update public.owner_rules set text=p.rule_text,source=p.source,confirmed_message_id=p_message_id,updated_at=now() where id=v_rule.id;
  elsif p.action='remove' then
    v_rule_id:=v_rule.id; v_number:=v_rule.number; v_previous:=v_rule.text;
    update public.owner_rules set active=false,updated_at=now() where id=v_rule.id;
  end if;
  update public.owner_rule_proposals set status='confirmed',decided_at=now(),rule_id=v_rule_id,previous_text=v_previous,fact_id=v_fact where id=p.id;
  return jsonb_build_object('action',p.action,'rule_number',v_number,'rule_text',p.rule_text,'fact_text',p.fact_text);
end $$;
revoke all on function public.confirm_owner_rule_proposal(uuid,uuid,text,integer,text,text,text) from public,anon,authenticated;
grant execute on function public.confirm_owner_rule_proposal(uuid,uuid,text,integer,text,text,text) to service_role;

-- «Запомнить на будущее? Да / Нет» after an owner answer reached the client: asked once per escalation.
alter table public.escalations add column if not exists remember_message_id text;
alter table public.escalations add column if not exists remember_state text check (remember_state is null or remember_state in ('offered','accepted','declined'));

-- Owner-initiated questions (interview gaps) are bundled: one message a day carries all the day's questions.
alter table public.owner_questions add column if not exists bundle_position integer;

commit;
