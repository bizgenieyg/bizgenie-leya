create table public.platform_feedback (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  message text not null check (char_length(btrim(message)) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index platform_feedback_tenant_created_idx
  on public.platform_feedback (tenant_id, created_at desc);

alter table public.platform_feedback enable row level security;

revoke all on table public.platform_feedback from anon, authenticated;
grant insert on table public.platform_feedback to authenticated;
grant select, insert, update, delete on table public.platform_feedback to service_role;

create policy "Tenant members submit platform feedback"
  on public.platform_feedback
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.tenant_users
      where tenant_users.tenant_id = platform_feedback.tenant_id
        and tenant_users.user_id = (select auth.uid())
    )
  );
