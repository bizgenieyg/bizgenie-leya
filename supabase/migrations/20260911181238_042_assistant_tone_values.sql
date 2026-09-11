-- Close assistant tone to the product-supported values.
-- Unknown legacy free-text values are normalized to the existing system default.
update public.assistant_profiles
set tone = case lower(trim(coalesce(tone, '')))
  when 'friendly_professional' then 'friendly_professional'
  when 'friendly' then 'friendly_professional'
  when 'warm_conversational' then 'warm_conversational'
  when 'concise_direct' then 'concise_direct'
  when 'formal_respectful' then 'formal_respectful'
  else 'friendly_professional'
end;

alter table public.assistant_profiles
  alter column tone set default 'friendly_professional',
  alter column tone set not null;

alter table public.assistant_profiles
  drop constraint if exists assistant_profiles_tone_check;

alter table public.assistant_profiles
  add constraint assistant_profiles_tone_check
  check (tone in (
    'friendly_professional',
    'warm_conversational',
    'concise_direct',
    'formal_respectful'
  ));
