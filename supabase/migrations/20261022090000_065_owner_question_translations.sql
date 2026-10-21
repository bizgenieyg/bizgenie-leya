-- Z8 review: owner-interview questions in the owner's language (owner_language). Gap questions come from the config;
-- operator questions keep their original text in `question` and the other languages here: {"ru": …, "he": …, "en": …}.
alter table public.owner_questions add column if not exists translations jsonb not null default '{}'::jsonb
  check (jsonb_typeof(translations) = 'object');
