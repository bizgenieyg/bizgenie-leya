begin;

-- Business sector/niche of the tenant (e.g. 'косметолог', 'парикмахер', 'ресторан').
-- Free text for now, nullable so existing tenants are unaffected. A controlled
-- enum/taxonomy may be introduced later at the application layer; keeping this as
-- text avoids the pain of ALTER TYPE on a Postgres enum. Used to adapt assistant
-- behavior, offer sector-specific setup templates, and segment tenants.
alter table public.tenants
  add column if not exists business_sector text;

commit;
