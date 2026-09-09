begin;

alter table public.conversations
  add column if not exists source_label text,
  add column if not exists routed_agent text,
  add column if not exists route_selected_at timestamptz,
  add column if not exists reception_question_asked boolean not null default false;

create table if not exists public.unrecognized_routes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  message_text text not null,
  created_at timestamptz not null default now()
);
create index if not exists unrecognized_routes_tenant_created on public.unrecognized_routes(tenant_id,created_at desc);
alter table public.unrecognized_routes enable row level security;
revoke all on public.unrecognized_routes from anon,authenticated;
grant select on public.unrecognized_routes to authenticated;
grant all on public.unrecognized_routes to service_role;
drop policy if exists "Tenant members read unrecognized routes" on public.unrecognized_routes;
create policy "Tenant members read unrecognized routes" on public.unrecognized_routes for select to authenticated
using(tenant_id in(select tenant_id from public.tenant_users where user_id=(select auth.uid())));

grant select(source_label,routed_agent,route_selected_at,reception_question_asked) on public.conversations to authenticated;

-- The former fallback is intentionally discarded. Enabled agents remain unchanged.
update public.notification_settings set behavior=coalesce(behavior,'{}'::jsonb)-'default_agent'
where coalesce(behavior,'{}'::jsonb)?'default_agent';

commit;
