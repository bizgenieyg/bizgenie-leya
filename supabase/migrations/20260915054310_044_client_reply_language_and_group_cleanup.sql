begin;

-- Preserve the language selected for this customer turn across delayed owner replies.
alter table public.escalations
  add column if not exists response_language text;

alter table public.escalations
  drop constraint if exists escalations_response_language_check;
alter table public.escalations
  add constraint escalations_response_language_check
  check (response_language is null or response_language in ('he', 'ru', 'en'));

-- Keep an operator-visible audit trail, then soft-delete legacy group cards.
-- GOWS normally reports groups via _data.Info.IsGroup and @g.us. The additional
-- 120363...@c.us pattern is the malformed group identifier observed in production.
insert into public.system_logs (tenant_id, level, event, details)
select c.tenant_id,
       'warn',
       'legacy_group_client_hidden',
       jsonb_build_object(
         'client_id', c.id,
         'whatsapp_jid', c.whatsapp_jid,
         'reason', 'group_identifier'
       )
from public.clients c
where c.deleted_at is null
  and (
    c.whatsapp_jid ~ '^120363[0-9]+@(c[.]us|g[.]us)$'
    or c.whatsapp_jid ~ '@g[.]us$'
  );

update public.clients c
set deleted_at = now()
where c.deleted_at is null
  and (
    c.whatsapp_jid ~ '^120363[0-9]+@(c[.]us|g[.]us)$'
    or c.whatsapp_jid ~ '@g[.]us$'
  );

commit;
