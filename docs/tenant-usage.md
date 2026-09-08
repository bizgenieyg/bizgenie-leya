# Tenant usage and monthly limits

Historical report for migration 025. The [review fixes in 026](review-runtime-settings.md) supersede voice defaults, warning thresholds, paused-input accounting and settings access below.

## Schema and defaults

Migration `025_tenant_usage_limits` extends existing `usage_events` with `event_key` for idempotency and reuses `tenant_usage_limits`. New `tenant_monthly_usage` stores tenant_id, local calendar month, time_zone, messages_used and voice_seconds_used. SQL is in `supabase/migrations/*_025_tenant_usage_limits.sql`.

Basic defaults live in `src/config/usage.ts`: 500 incoming customer messages/month and 0 voice seconds (voice processing is not part of Phase 1). Existing explicit tariff values remain unchanged. No new environment variables are required.

Only admitted incoming customer messages consume the message quota. Owner commands, outbound messages and model calls do not. Paused conversations do not consume quota. The last message within the limit completes normally; subsequent inputs receive a neutral explanation that the owner can respond personally. Human owner replies remain available.

The month uses `notification_settings.time_zone`, or UTC if not configured. History is retained; a new month gets a fresh row. Admission and threshold notifications are atomic under a PostgreSQL row lock. A repeated incoming message ID does not consume quota twice. Events lacking a transport ID get a generated ID and cannot be deduplicated across webhook deliveries.

## Events and call sites

- `message_received`: text webhook worker and voice accounting handler; includes owner/control and quota-rejected inputs for operational totals.
- `message_sent`: WhatsApp decorator, after successful transport delivery, including owner notifications, escalation transfers and scheduler sends.
- `model_call`: AI decorator, every attempted Gemini call including failed calls and owner-answer translation. Disabled Gemini creates no event.
- `voice_received`: audio accounting handler, quantity in seconds. No transcription or media download.
- `quota_admission`: internal idempotency receipt; not an additional message/model event.

Gemini usage metadata includes model, input/output/total, thinking and cached input token counts when supplied. Missing usage is explicitly counted by `calls_without_token_usage`; failed requests are not assumed free. Cached input is part of input tokens, not an extra amount to add. Pricing conversion is not implemented. Reference: https://ai.google.dev/api/generate-content#UsageMetadata

GOWS audio duration is read from `_data.Message.audioMessage.seconds`. Tests use an audio-shaped fixture derived from the existing GOWS fixture, not a captured production audio message. Missing duration is marked `duration_known:false` and contributes no invented seconds. Audio receives a text-only explanation; a denied quota receives the limit explanation. Groups, outgoing messages, owner messages, allowlist and pauses remain respected. Existing input filters and webhook authentication are unchanged.

## Limits and cabinet aggregate

Server administrative API, using the existing `Authorization: Bearer <ADMIN_SECRET>` authentication:

- `GET /api/admin/usage?tenantId=UUID`: current month/time zone/bounds; messages_used/messages_limit; voice_seconds_used/voice_minutes_used/voice_minutes_limit; separate operational event and token aggregates.
- `PATCH /api/admin/usage-limits?tenantId=UUID`: JSON `{"messagesPerMonth":1000,"voiceMinutesPerMonth":60}`. Both nonnegative integer values are required.

Only the trusted backend can change limits. Public setup tokens cannot modify them. A future cabinet caller must use its server proxy and derive tenantId from the authenticated membership; this change adds the backend aggregate, not a cabinet widget.

Alternatively an operator can set limits in Supabase SQL Editor (substitute the actual tenant UUID):

```sql
insert into public.tenant_usage_limits
  (tenant_id, messages_per_month, voice_minutes_per_month)
values ('TENANT_UUID'::uuid, 1000, 60)
on conflict (tenant_id) do update set
  messages_per_month = excluded.messages_per_month,
  voice_minutes_per_month = excluded.voice_minutes_per_month,
  updated_at = now();
```

Zero messages disables automatic answers. Zero voice allowance disables audio admission but does not disable text. Exhausting a positive voice allowance also stops automatic replies. Oversized audio is rejected without consuming the remaining seconds.

## Notifications and failure behavior

80% and exhausted notices are queued once per tenant/month/resource in `scheduled_jobs`, delivered to the configured separate owner destination immediately or by the existing minute scheduler. Missing owner destination leaves a pending notice. Ambiguous delivery failures are marked `error` for operator review, not automatically resent. Client explanations are deterministic Russian/Hebrew/English and never call Gemini.

RLS permits members to read their counters/limits. Clients cannot write usage or tariff limits. Admission/aggregate RPC execution is restricted to service_role; functions are SECURITY INVOKER.

Usage recording failures log safe event information and do not stop processing. If the quota database check itself is unavailable, processing continues (fail-open) with `usage_admission_unavailable`; this means quota enforcement and accounting cannot be guaranteed during a database outage. Full message texts and secrets are not logged by metering.

## Verification and rollout

Run `npm install`, `npm run build`, `npm run typecheck`, `npm test`. Tests cover SQL idempotency/RLS, tenant isolation, concurrent admission, month boundaries, 80%/100% uniqueness, voice duration, failed metering and the actual webhook worker's quota gate before FAQ/Gemini.

Apply migration 025 before restarting the backend. Existing historical events are retained; quota counters start with this rollout, because earlier logs do not reliably distinguish admitted customer inputs. No historical backfill is fabricated. Deploy on VPS using the project's existing pull/build/PM2 process. No VPS restart is performed by this repository change.

Migration applied successfully through Supabase apply_migration on 2026-09-08, recorded version `20260908164604`. Build/typecheck and all 84 tests passed.

Post-migration security review confirmed RLS on all three usage tables and denied client mutation/RPC access. No new usage-table findings. Existing unrelated findings remain: nine RLS-enabled tables without client policies ([reference](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)); public execution of `rls_auto_enable` ([reference](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable)); authenticated SECURITY DEFINER access including the intentional tenant-creation RPC ([reference](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable)); disabled [leaked-password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection). These pre-existing settings were not changed by the usage migration.
