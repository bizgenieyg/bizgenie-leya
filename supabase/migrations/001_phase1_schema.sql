create extension if not exists pgcrypto;

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  business_name text,
  phone text not null,
  birthday date,
  language text default 'he',
  tier text default 'starter',
  status text default 'trial',
  trial_ends_at timestamptz,
  created_at timestamptz default now()
);

create table public.assistant_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants unique,
  assistant_name text default 'Лея',
  tone text default 'friendly_professional',
  mode text default 'assisted',
  allowed_languages text[] default array['he', 'ru', 'en'],
  system_rules text,
  style_profile_md text,
  created_at timestamptz default now()
);

create table public.whatsapp_instances (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants,
  waha_url text not null,
  waha_api_key_encrypted text,
  webhook_secret_encrypted text,
  session_name text default 'default',
  phone text,
  status text default 'active',
  last_health_check_at timestamptz,
  created_at timestamptz default now()
);

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants,
  phone text not null,
  name text,
  birthday date,
  language text,
  notes text,
  consent_given_at timestamptz,
  first_seen_at timestamptz default now(),
  last_seen_at timestamptz,
  unique (tenant_id, phone)
);

create table public.client_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants,
  client_id uuid references public.clients unique,
  profile_md text,
  last_updated_at timestamptz default now()
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants,
  client_id uuid references public.clients,
  status text default 'active',
  last_message_at timestamptz,
  created_at timestamptz default now()
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations,
  tenant_id uuid references public.tenants,
  from_me boolean not null,
  body text,
  msg_type text default 'text',
  waha_msg_id text,
  raw_payload jsonb,
  created_at timestamptz default now()
);

create table public.knowledge_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants,
  type text not null,
  question text,
  answer text not null,
  language text default 'he',
  active boolean default true,
  source text default 'manual',
  created_at timestamptz default now()
);

create table public.services (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants,
  name text not null,
  description text,
  price_min integer,
  price_max integer,
  fixed_price integer,
  duration_minutes integer,
  active boolean default true,
  created_at timestamptz default now()
);

create table public.module_settings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants,
  module_name text not null,
  enabled boolean default false,
  settings jsonb default '{}',
  limits jsonb default '{}',
  created_at timestamptz default now(),
  unique (tenant_id, module_name)
);

create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants,
  event_type text not null,
  quantity integer default 1,
  metadata jsonb default '{}',
  created_at timestamptz default now()
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants,
  tier text not null,
  addons jsonb default '[]',
  monthly_fee integer,
  status text default 'trial',
  trial_ends_at timestamptz,
  next_payment_at timestamptz,
  created_at timestamptz default now()
);

create table public.subscription_addons (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants on delete cascade,
  addon_code text not null,
  status text default 'active',
  monthly_fee integer,
  limits jsonb default '{}',
  started_at timestamptz default now(),
  cancelled_at timestamptz,
  unique (tenant_id, addon_code)
);

create table public.tenant_usage_limits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants on delete cascade unique,
  messages_per_month integer default 500,
  ai_calls_per_month integer,
  voice_minutes_per_month integer default 0,
  ocr_scans_per_month integer default 0,
  active_modules integer default 1,
  updated_at timestamptz default now()
);

create table public.agent_actions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants,
  conversation_id uuid references public.conversations,
  action_type text not null,
  input text,
  output text,
  ai_provider text,
  tokens_used integer,
  created_at timestamptz default now()
);

create table public.scheduled_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants,
  job_type text not null,
  payload jsonb default '{}',
  scheduled_at timestamptz not null,
  executed_at timestamptz,
  status text default 'pending',
  error text
);

create table public.system_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants,
  level text not null,
  event text not null,
  details jsonb default '{}',
  created_at timestamptz default now()
);

create table public.onboarding_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants on delete cascade,
  setup_token_hash text not null,
  status text default 'draft',
  current_step text default 'business_profile',
  completed_steps jsonb default '[]',
  expires_at timestamptz,
  created_at timestamptz default now(),
  completed_at timestamptz
);

create table public.notification_settings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants on delete cascade unique,
  quiet_hours_start time,
  quiet_hours_end time,
  mode text default 'mute_all',
  whitelist_client_ids jsonb default '[]',
  created_at timestamptz default now()
);

-- Created for forward compatibility only. No Phase 1 application logic uses these tables.
create table public.work_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants,
  client_id uuid references public.clients,
  type text not null,
  title text,
  details jsonb default '{}',
  scheduled_at timestamptz,
  status text default 'pending',
  created_at timestamptz default now()
);

create table public.promises (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants,
  client_id uuid references public.clients,
  conversation_id uuid references public.conversations,
  text text not null,
  due_at timestamptz,
  status text default 'pending',
  created_at timestamptz default now()
);

create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants,
  client_id uuid references public.clients,
  work_item_id uuid references public.work_items,
  type text,
  scheduled_at timestamptz not null,
  sent_at timestamptz,
  status text default 'pending'
);
