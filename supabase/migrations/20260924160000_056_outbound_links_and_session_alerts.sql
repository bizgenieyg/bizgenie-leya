-- 056: assistant messages link to their outbound queue row at enqueue time; the sender
-- stamps waha_msg_id after delivery. Session alert state survives process restarts.
begin;

alter table public.messages
  add column if not exists outbound_message_id uuid references public.outbound_messages(id) on delete set null;
create index if not exists messages_outbound_message_idx on public.messages(outbound_message_id)
  where outbound_message_id is not null;

create index if not exists outbound_waha_msg_idx on public.outbound_messages(tenant_id, waha_msg_id)
  where waha_msg_id is not null;
create index if not exists outbound_sending_chat_idx on public.outbound_messages(tenant_id, started_at)
  where status = 'sending';

alter table public.whatsapp_instances
  add column if not exists last_session_alert text check (last_session_alert in ('session_down','session_recovered'));
-- 'session_recovered' doubles as "has been connected": onboarding sessions that never reached
-- WORKING stay null and never raise a disconnect alert.
update public.whatsapp_instances set last_session_alert = 'session_recovered'
  where last_session_alert is null and upper(status) = 'WORKING';

commit;
