alter table public.whatsapp_instances
  add column if not exists status_changed_at timestamptz not null default now();
