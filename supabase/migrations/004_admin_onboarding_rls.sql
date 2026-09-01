alter table public.tenants
  alter column phone drop not null;

create policy "Authenticated users can create tenants"
  on public.tenants
  for insert
  to authenticated
  with check (true);

create policy "Users can create own tenant links"
  on public.tenant_users
  for insert
  to authenticated
  with check (user_id = auth.uid());
