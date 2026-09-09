begin;
alter table public.conversations add column if not exists reception_message_count integer not null default 0 check(reception_message_count>=0);
grant select(reception_message_count) on public.conversations to authenticated;
commit;
