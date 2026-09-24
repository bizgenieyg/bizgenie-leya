-- 058: snapshot of the client's real phone on each escalation, so owner notifications and
-- reminders show it even when the client was merged across @lid/@c.us chat ids.
begin;
alter table public.escalations add column if not exists client_phone text
  check (client_phone is null or client_phone ~ '^[0-9]{8,15}$');
update public.escalations e set client_phone = c.phone
  from public.conversations cv join public.clients c on c.id = cv.client_id and c.tenant_id = cv.tenant_id
  where cv.id = e.conversation_id and cv.tenant_id = e.tenant_id and e.client_phone is null
    and c.phone ~ '^[0-9]{8,15}$';
commit;
