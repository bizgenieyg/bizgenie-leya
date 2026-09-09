begin;

-- Conversation context is now a read-only window (see src/services/context.service.ts);
-- message rows are swept by a separate background job (src/services/message-retention.service.ts)
-- keyed on (tenant_id, created_at). The weekly report count query filters on the same pair.
create index if not exists idx_messages_tenant_created
  on public.messages (tenant_id, created_at);

-- 029 added conversations.reception_question_asked but nothing ever reads it; the reception
-- flow is driven by routed_agent / reception_message_count instead. Drop the dead column.
alter table public.conversations drop column if exists reception_question_asked;

commit;
