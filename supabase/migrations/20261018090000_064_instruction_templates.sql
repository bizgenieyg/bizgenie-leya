-- 064 (task Z6): instruction templates by deal type (service_booking, order, project, b2b, general) for tenants
-- without their own business instruction. Versions; one active per template key. Service-only (no member policy:
-- the existing select policy covers kind = 'business' only).
begin;

alter table public.assistant_instructions add column if not exists template_key text
  check (template_key is null or template_key ~ '^[a-z][a-z0-9_]{1,39}$');

alter table public.assistant_instructions drop constraint if exists assistant_instructions_kind_check;
alter table public.assistant_instructions add constraint assistant_instructions_kind_check
  check (kind in ('business', 'demo', 'template'));

alter table public.assistant_instructions drop constraint if exists assistant_instructions_check;
alter table public.assistant_instructions add constraint assistant_instructions_check check (
  kind = 'business' and tenant_id is not null and demo_key is null and template_key is null
  or kind = 'demo' and tenant_id is null and demo_key is not null and template_key is null
  or kind = 'template' and tenant_id is null and demo_key is null and template_key is not null
);

create unique index if not exists assistant_instructions_template_version on public.assistant_instructions(template_key, version) where kind = 'template';
create unique index if not exists assistant_instructions_one_active_template on public.assistant_instructions(template_key) where kind = 'template' and status = 'active';

commit;
