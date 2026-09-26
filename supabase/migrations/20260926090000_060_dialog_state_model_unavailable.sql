-- 060: conversation stage kept by code (stage, sticky intent, turns, discovery questions asked);
-- escalations created while the model was unavailable are marked (no knowledge suggestions from them).
begin;

alter table public.conversations add column if not exists dialog_state jsonb not null default '{}'::jsonb
  check (jsonb_typeof(dialog_state) = 'object');
alter table public.simulator_sessions add column if not exists dialog_state jsonb not null default '{}'::jsonb
  check (jsonb_typeof(dialog_state) = 'object');
alter table public.escalations add column if not exists model_unavailable boolean not null default false;

commit;
