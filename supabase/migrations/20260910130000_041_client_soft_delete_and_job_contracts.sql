begin;

alter table public.clients
  add column if not exists deleted_at timestamptz;

create index if not exists clients_tenant_visible_last_seen
  on public.clients(tenant_id,last_seen_at desc)
  where deleted_at is null;

-- One aggregate query serves both the directory and a single card without loading messages.
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
  where c.tenant_id=p_tenant_id and (p_client_id is null or c.id=p_client_id);
$$;
revoke all on function public.client_card_stats(uuid,uuid) from public,anon,authenticated;
grant execute on function public.client_card_stats(uuid,uuid) to service_role;

create or replace function public.client_recent_messages(p_tenant_id uuid,p_client_id uuid,p_limit integer default 20)
returns table(id uuid,conversation_id uuid,from_me boolean,body text,msg_type text,created_at timestamptz)
language sql stable security invoker set search_path=public as $$
  select m.id,m.conversation_id,m.from_me,m.body,m.msg_type,m.created_at
  from public.messages m join public.conversations c on c.id=m.conversation_id
  where m.tenant_id=p_tenant_id and c.tenant_id=p_tenant_id and c.client_id=p_client_id
  order by m.created_at desc limit least(greatest(p_limit,1),100);
$$;
revoke all on function public.client_recent_messages(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.client_recent_messages(uuid,uuid,integer) to service_role;

update public.scheduled_jobs set status='pending' where status is null;
alter table public.scheduled_jobs alter column status set not null;
alter table public.scheduled_jobs drop constraint if exists scheduled_jobs_job_type_check;
alter table public.scheduled_jobs add constraint scheduled_jobs_job_type_check
  check(job_type in ('owner_escalation','owner_summary','usage_limit_notice','weekly_report'));
alter table public.scheduled_jobs drop constraint if exists scheduled_jobs_status_check;
alter table public.scheduled_jobs add constraint scheduled_jobs_status_check
  check(status in ('pending','sending','done','error','cancelled'));

commit;
