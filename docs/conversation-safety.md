# Conversation takeover, delayed work and memory

Migration 028 adds `conversations.owner_last_activity_at` and `assistant_introduced_at`, plus terminal escalation states `resolved_by_owner` and `expired`.

It was applied through Supabase apply_migration and recorded as `20260909073722_conversation_takeover_and_memory`. The live schema contains both conversation columns. Security advisors reported the same pre-existing findings as migration 027 and no new finding caused by 028.

Runtime tenant defaults live in `src/config/behavior.ts`:

- `auto_resume_hours`: `0` (disabled). A positive value resumes a conversation after that many hours without a manual owner send.
- `deferred_max_age_hours`: `12`. Older queued escalation work is cancelled without sending anything.
- `context_message_count`: `10`. The model receives at most this many recent customer/bot text messages.
- `context_retention_hours`: `48`. Older conversation messages are removed when the dialogue is next processed.

An authenticated WAHA `fromMe` event is still rejected by the incoming-customer policy. Before returning, the webhook route sends it to the owner-outgoing observer. Manual app-originated sends pause the matching active conversation, persist owner activity and close its open escalation. WAHA API-originated bot sends and message IDs already stored as bot outputs are ignored by this observer.

Immediately before queued owner notification, reminder or timeout delivery, the worker checks owner activity against escalation creation time and checks maximum age. Owner activity closes the escalation as `resolved_by_owner`; age closes it as `expired`; the queued job becomes `cancelled` and no customer message is sent.

Customer sends never pass `replyTo`. Quoted messages remain limited to owner-facing workflow messages, where WAHA reply IDs identify the escalation. The first customer response marks `assistant_introduced_at`; later model prompts forbid another greeting or introduction, and deterministic default templates remove the repeated assistant introduction.
