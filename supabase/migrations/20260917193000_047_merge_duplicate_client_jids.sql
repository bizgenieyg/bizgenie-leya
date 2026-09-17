begin;

create temporary table _client_jid_duplicates on commit drop as
with ranked as (
  select id,
    first_value(id) over (
      partition by tenant_id,
        regexp_replace(whatsapp_jid,'@(c[.]us|s[.]whatsapp[.]net|lid)$',''),
        lower(btrim(name))
      order by first_seen_at nulls last,id
    ) as keeper_id,
    row_number() over (
      partition by tenant_id,
        regexp_replace(whatsapp_jid,'@(c[.]us|s[.]whatsapp[.]net|lid)$',''),
        lower(btrim(name))
      order by first_seen_at nulls last,id
    ) as position
  from public.clients
  where chat_type='individual'
    and name is not null and btrim(name)<>''
    and whatsapp_jid ~ '^[0-9]+@(c[.]us|s[.]whatsapp[.]net|lid)$'
)
select id as duplicate_id,keeper_id from ranked where position>1;

update public.conversations c
set client_id=d.keeper_id
from _client_jid_duplicates d
where c.client_id=d.duplicate_id;

delete from public.client_profiles duplicate
using _client_jid_duplicates d
where duplicate.client_id=d.duplicate_id
  and exists(select 1 from public.client_profiles keeper where keeper.client_id=d.keeper_id);

update public.client_profiles profile
set client_id=d.keeper_id
from _client_jid_duplicates d
where profile.client_id=d.duplicate_id;

update public.clients keeper
set first_seen_at=least(keeper.first_seen_at,duplicate.first_seen_at),
    last_seen_at=greatest(keeper.last_seen_at,duplicate.last_seen_at),
    notes=coalesce(keeper.notes,duplicate.notes),
    language=coalesce(keeper.language,duplicate.language),
    auto_reply_allowed=keeper.auto_reply_allowed and duplicate.auto_reply_allowed,
    auto_reply_opted_out_at=coalesce(keeper.auto_reply_opted_out_at,duplicate.auto_reply_opted_out_at),
    deleted_at=case when keeper.deleted_at is null or duplicate.deleted_at is null then null else greatest(keeper.deleted_at,duplicate.deleted_at) end
from _client_jid_duplicates d
join public.clients duplicate on duplicate.id=d.duplicate_id
where keeper.id=d.keeper_id;

delete from public.clients duplicate
using _client_jid_duplicates d
where duplicate.id=d.duplicate_id;

commit;
