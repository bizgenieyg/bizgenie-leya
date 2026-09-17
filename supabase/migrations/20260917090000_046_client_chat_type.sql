begin;

alter table public.clients
  add column if not exists chat_type text not null default 'individual';

alter table public.clients drop constraint if exists clients_chat_type_check;
alter table public.clients add constraint clients_chat_type_check
  check (chat_type in ('individual','group'));

update public.clients
set chat_type = case
  when whatsapp_jid like '%@g.us'
    or whatsapp_jid ~ '^120363[0-9]+@c[.]us$'
  then 'group'
  else 'individual'
end;

create index if not exists clients_tenant_individual_last_seen
  on public.clients(tenant_id,last_seen_at desc)
  where deleted_at is null and chat_type='individual';

-- Keep aggregate RPCs from exposing historical group rows to the cabinet.
create or replace function public.client_card_stats(p_tenant_id uuid,p_client_id uuid default null)
returns table(client_id uuid,inquiry_count bigint,current_conversation_id uuid,current_status text,current_agent text)
language sql stable security invoker set search_path=public as $$
  select c.id,
    (select count(*) from public.messages m join public.conversations mc on mc.id=m.conversation_id
      where mc.tenant_id=p_tenant_id and mc.client_id=c.id and m.tenant_id=p_tenant_id and m.from_me=false),
    latest.id,
    case when latest.id is null then 'new'
      when exists(select 1 from public.escalations e where e.tenant_id=p_tenant_id and e.conversation_id=latest.id
        and e.status in ('queued','notifying','pending','reminding','delivering','delivery_uncertain','closing')) then 'waiting_owner'
      when latest.status='active' then 'in_dialogue' else 'closed' end,
    latest.routed_agent
  from public.clients c
  left join lateral(select v.id,v.status,v.routed_agent from public.conversations v
    where v.tenant_id=p_tenant_id and v.client_id=c.id order by v.created_at desc limit 1) latest on true
  where c.tenant_id=p_tenant_id and c.chat_type='individual'
    and (p_client_id is null or c.id=p_client_id);
$$;
revoke all on function public.client_card_stats(uuid,uuid) from public,anon,authenticated;
grant execute on function public.client_card_stats(uuid,uuid) to service_role;

commit;
