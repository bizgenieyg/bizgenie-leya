begin;

create table public.tenant_users (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner', 'admin', 'viewer')),
  created_at timestamptz not null default now(),
  unique (user_id, tenant_id)
);

create index tenant_users_tenant_id_idx
  on public.tenant_users (tenant_id);

alter table public.tenant_users enable row level security;

revoke all on table public.tenant_users from anon, authenticated;
grant select on table public.tenant_users to authenticated;

create policy "Users see own tenant links"
  on public.tenant_users
  for select
  to authenticated
  using (user_id = (select auth.uid()));

do $migration$
declare
  table_name text;
  policy_prefix text;
begin
  for table_name, policy_prefix in
    select *
    from (values
      ('assistant_profiles', 'assistant profiles'),
      ('clients', 'clients'),
      ('client_profiles', 'client profiles'),
      ('conversations', 'conversations'),
      ('messages', 'messages'),
      ('knowledge_items', 'knowledge items'),
      ('module_settings', 'module settings'),
      ('usage_events', 'usage events'),
      ('agent_actions', 'agent actions'),
      ('scheduled_jobs', 'scheduled jobs')
    ) as tables(table_name, policy_prefix)
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format(
      'create policy %I on public.%I for select to authenticated using (tenant_id in (select tenant_id from public.tenant_users where user_id = (select auth.uid())))',
      'Tenant members can SELECT ' || policy_prefix,
      table_name
    );
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (tenant_id in (select tenant_id from public.tenant_users where user_id = (select auth.uid())))',
      'Tenant members can INSERT ' || policy_prefix,
      table_name
    );
    execute format(
      'create policy %I on public.%I for update to authenticated using (tenant_id in (select tenant_id from public.tenant_users where user_id = (select auth.uid()))) with check (tenant_id in (select tenant_id from public.tenant_users where user_id = (select auth.uid())))',
      'Tenant members can UPDATE ' || policy_prefix,
      table_name
    );
    execute format(
      'create policy %I on public.%I for delete to authenticated using (tenant_id in (select tenant_id from public.tenant_users where user_id = (select auth.uid())))',
      'Tenant members can DELETE ' || policy_prefix,
      table_name
    );
  end loop;
end
$migration$;

commit;
