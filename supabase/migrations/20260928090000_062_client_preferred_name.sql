-- 062: the name a client gave in the chat ("меня зовут Аня") lives on the client, not in one
-- conversation's dialog_state, so it survives new conversations and is visible in the cabinet.
-- Priority in replies: preferred_name → a usable WhatsApp display name → no name.
begin;

alter table public.clients add column if not exists preferred_name text
  check (preferred_name is null or length(preferred_name) between 1 and 40);
alter table public.clients add column if not exists preferred_name_source text
  check (preferred_name_source is null or preferred_name_source in ('client','owner'));
-- The simulator has no clients row: its session keeps the same name.
alter table public.simulator_sessions add column if not exists preferred_name text
  check (preferred_name is null or length(preferred_name) between 1 and 40);

-- One-time move of names already kept in dialog_state (task Q). Done here, in the same transaction
-- as the columns, so there is no window where the code reads the column before it is filled; the
-- latest conversation wins when a client has several.
update public.clients c set preferred_name = src.name, preferred_name_source = 'client'
from (
  select distinct on (cv.client_id) cv.client_id, left(btrim(cv.dialog_state->>'client_name'), 40) as name
  from public.conversations cv
  where coalesce(btrim(cv.dialog_state->>'client_name'), '') <> ''
  order by cv.client_id, cv.last_message_at desc nulls last
) src
where c.id = src.client_id and c.preferred_name is null;
update public.conversations set dialog_state = dialog_state - 'client_name' where dialog_state ? 'client_name';

update public.simulator_sessions set preferred_name = left(btrim(dialog_state->>'client_name'), 40)
where coalesce(btrim(dialog_state->>'client_name'), '') <> '' and preferred_name is null;
update public.simulator_sessions set dialog_state = dialog_state - 'client_name' where dialog_state ? 'client_name';

commit;
