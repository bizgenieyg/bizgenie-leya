# Review fixes: runtime tenant settings, agents and voice

## Scope and rollout

This change addresses review items 1–10. It does not change incoming filters, webhook authentication, the WhatsApp session provider, or onboarding pages. Media download lives in a separate adapter. Next.js adds `/admin/settings` and `/api/tenant-settings` in the existing visual style.

Migration **026_runtime_behavior_and_agents** supersedes the live functions from 025; already applied historical SQL is not rewritten. Supabase's actual migration history was checked: 024 is recorded as 20260908114713 and 025 as 20260908164604. Regardless of their earlier manual execution, 026 runs after both and reuses both schemas. Exact SQL is in `supabase/migrations/*_026_runtime_behavior_and_agents.sql`.

Apply SQL before restarting the backend. Add `STT_API_KEY` on the VPS (a Gemini API key; same provider account is allowed). Optional `STT_MODEL`, default `gemini-2.5-flash-lite`. Missing key disables recognition with `stt_disabled_missing_key` and a client explanation. No new Vercel secrets: new server-only `LEYA_API_URL` and `LEYA_ADMIN_API_KEY` are preferred; deprecated `LEIA_*` aliases remain available during stage 1.

## Settings and system defaults

All newly introduced behavioral defaults are in `src/config/behavior.ts`, `usage.ts`, `agents.ts` and `templates.ts`. Null/missing overrides inherit config on every request/scheduler pass; changing tenant settings takes effect without deployment. Existing explicit settings remain overrides.

| Setting | DB location | System default | Cabinet |
|---|---|---|---|
| Assigned tariff | tenant_usage_limits.plan | unset | Read only |
| Incoming messages/month | tenant_usage_limits.messages_per_month | 500 | Read only |
| Voice minutes/month | tenant_usage_limits.voice_minutes_per_month | 60 | Read only |
| Warning percentage | tenant_usage_limits.warning_percent | 80 | Read only |
| Translate owner's answer | notification_settings.translate_owner_answer | false | Yes |
| Remind owner after active minutes | notification_settings.behavior.escalation_remind_minutes | 120 | Yes |
| Close unanswered after active minutes | behavior.escalation_close_minutes | 1440 | Yes |
| Accounting failure alert interval, minutes | behavior.usage_failure_alert_minutes | 60 | API |
| Pairing code lifetime, minutes | behavior.pairing_ttl_minutes | 30 | API |
| Scheduler interval per tenant, seconds | behavior.scheduler_interval_seconds | 60 | API |
| STT confidence threshold | behavior.stt_confidence_threshold | 0.85 | API |
| STT/download timeout, seconds | behavior.stt_timeout_seconds | 30 | API |
| Download maximum bytes | behavior.media_max_bytes | 10485760 | API |
| Owner notification language | behavior.owner_language | ru (he/en supported) | API |
| Enabled agents | behavior.enabled_agents | SALE, SUPPORT | Yes |
| Intent confidence threshold | behavior.intent_confidence_threshold | 0.75 | Yes |
| Route stickiness | behavior.route_stickiness_hours | 24 hours | Yes |
| Campaign routes | behavior.campaign_routes | empty | Yes |
| First-message source routes | behavior.source_routes | empty | Yes |
| Agent priority, keywords and prompt overrides | behavior.agent_overrides | no overrides | API |
| Client and owner templates | notification_settings.templates | he/ru/en config catalog | API, intentionally not UI |
| Owner phone | notification_settings.owner_phone | unset; owner supplies it | Yes, existing pairing API |
| Weekly work schedule | notification_settings.behavior.weekly_schedule | full working day, all days | Yes |
| Owner time zone | notification_settings.time_zone | Asia/Jerusalem | Yes |
| Pause auto replies | notification_settings.auto_replies_paused | existing false default | Yes |
| Auto-resume after owner inactivity, hours | behavior.auto_resume_hours | 0 (disabled) | Yes |
| Maximum delayed-answer age, hours | behavior.deferred_max_age_hours | 12 | Yes |
| Conversation context messages | behavior.context_message_count | 10 | Yes |
| Conversation context retention, hours | behavior.context_retention_hours | 48 | Yes |

`behavior.*` above is inside notification_settings. The initial 026 upgrade clears the old zero voice allowance to NULL so existing tenants inherit the nonzero basic allowance. This one-time conversion is guarded; an explicit zero set after upgrade remains zero and blocks recognition.

Tenant settings use `GET/PATCH /api/admin/tenant-settings?tenantId=UUID` with existing `Authorization: Bearer ADMIN_SECRET`. The PATCH endpoint rejects `plan`, `messages_per_month`, `voice_minutes_per_month`, and `warning_percent`, including crafted browser requests. System tariff values are changed only through `PATCH /api/admin/usage-limits?tenantId=UUID` with the same operator secret:

```json
{
  "messagesPerMonth": 1000,
  "voiceMinutesPerMonth": 60,
  "warningPercent": 75,
  "plan": "basic"
}
```

Backend validates types, supported IANA time zones, the complete seven-day schedule, default-agent membership and reminder-before-close. The supported-zone list is returned by the backend and drives the cabinet dropdown. The browser can only submit tenant settings; tenantId is derived from authenticated membership, role must be owner/admin, and cross-origin mutations are rejected. Pairing credentials and backend keys never appear in the settings response.

Migration 027 adds `schedule_exceptions`: tenant_id, start_date/end_date, kind (`day_off` or `special_hours`), optional work_start/work_end, name, recurs_annually and timestamps. Owner/admin CRUD is tenant-isolated by RLS. Exceptions override the weekday schedule. Annual entries match month/day; holidays are never preloaded. Legacy quiet-hours pairs are converted into the same working-hours row for all seven weekdays. The migration also grants authenticated SELECT on the three notification columns added by 026.

## Texts and translation

`templates.ts` separates `client.*` and `owner.*` catalogs. Overrides use named `{answer}`, `{question}`, `{time}`, `{zone}`, `{name}`, etc. Unknown template names/placeholders and angle brackets are rejected through the API. Rendering strips markup/unfilled placeholders, including from interpolated content, with config fallback. Command tokens remain Russian protocol tokens in owner instructions so translated instructions still match the command parser.

Translation calls are strictly guarded by translate_owner_answer. When false, the owner's text is forwarded unchanged inside the configured assistant attribution template, subject to existing markup sanitization. Learning retains the original answer and still requires explicit quoted confirmation.

## Escalation lifecycle

Pending time starts when the first owner notification is delivered. The scheduler counts elapsed UTC instants outside the owner's local quiet hours, including DST changes. Thresholds are reread each pass. One reminder includes the original question; its message ID is added to owner_message_ids so a reply to either notification reaches the same case. After the close threshold, a client timeout template is sent and the case becomes `closed_unanswered` only after confirmed delivery. This is not a successful answer and does not trigger learning. Global/conversation pauses prevent automatic reminder/closure sends.

Conditional database claims prevent concurrent duplicate reminders or closure. Ambiguous delivery is logged and left for operator review (`delivery_uncertain`; interrupted claims can remain `reminding`/`closing`) rather than blindly sending duplicates. Client delivery failure is never reported as successful closure.

## Agent registry

`src/agents/registry.ts` defines registration metadata: name, priority, signals, system prompt, declared actions, default enablement and execution. `src/agents/index.ts` registers SALE and SUPPORT from config. Cheap keyword/regex signals select one match without a model; multiple matches may call the model for a label. Unknown/invalid classification falls back to the configured enabled default. Disabled agents are not candidates. Runtime keyword overrides are escaped literal keywords, not arbitrary regex programs.

The shared core retains identity filters, pause checks, quota admission, FAQ lookup, Gemini knowledge fallback, escalation and accounting. Agents only receive allowed core actions. SALE's prompt covers services/prices/enquiries; SUPPORT covers problems/status/questions. Neither books appointments nor invents service status.

Usage rows have `agent`: customer work is tagged SALE/SUPPORT (or a future registered agent), ambiguous classifier usage is attributed after selection, and STT usage is initially recorded then attributed after transcript routing. Administrative owner controls/scheduled infrastructure use `CORE`; no customer agent is invented for such events. Low-confidence/unavailable transcription uses the configured default because no reliable intent exists.

To add an agent:

1. Add its defaults (priority/signals/prompt) in config.
2. Register an AgentDefinition in the registration module; declare only supported core actions and implement `execute(core)`.
3. Enable its name in that tenant's enabled_agents; optionally select it as default.
4. Test positive/negative routing, tenant enablement and usage attribution. Add a new core capability only when its business feature is approved.

The router/worker need no edit for another agent using existing actions. Future calendar, promises, group monitoring and congratulations are not implemented; current incoming filters still reject groups.

## Voice/STT choice and costs

chef-bot inspected locally at `/tmp/leya-chef-bot`: index.js uses `payload.media.mimetype` (plus its older PTT fallback) and downloads using the media URL's path/query on trusted WAHA_URL with X-Api-Key. Its transcriber writes OGG/MP3 temporary files, invokes ffmpeg, and asks Gemini 2.5 Flash for Russian text. Leya instead uses engine-independent MIME detection, a session-bound trusted media adapter with redirect/size/time bounds, and no conversion or disk files. WAHA's MediaLocalStorage key is `session/message-id.extension`, verified in source.

Chosen provider: Gemini **2.5 Flash-Lite**, behind `STTProvider`. It supports audio input and structured output; transcription preserves Hebrew/Russian/English rather than translating everything into Russian. Separate Google Cloud Speech-to-Text also supports Hebrew/Russian and provides speech-specific models, but introduces another credential/API flow. Its standard list price is $0.016/minute versus Gemini Flash-Lite audio input at $0.30/million tokens. Gemini uses 1,920 audio tokens/minute: approximately **$0.000576/minute for audio input**, or **$0.03456 for 60 minutes**, plus prompt/output tokens and subsequent assistant calls. This is the basis for proposing 60 basic voice minutes, not a claim of total tenant cost.

Sources checked 2026-09-08: [Gemini audio](https://ai.google.dev/gemini-api/docs/audio), [model](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite), [Gemini prices](https://ai.google.dev/gemini-api/docs/pricing), [Cloud STT prices](https://cloud.google.com/speech-to-text/pricing), [Cloud STT languages](https://docs.cloud.google.com/speech-to-text/docs/speech-to-text-supported-languages).

There is no verified comparative Hebrew/Russian accuracy benchmark for this project's recordings. Gemini's reported confidence is a conservative routing signal, not calibrated probability. Structured ambiguity flags for names/dates/quantities or confidence below threshold trigger a clarification template and never enter FAQ/agents with guessed details. Real representative voice recordings still need an acceptance check after the key is installed.

Duration is parsed from downloaded audio using pinned music-metadata; missing/unreadable duration stops STT rather than allowing unmetered recognition. Quota is admitted before STT. Every admitted customer voice message consumes one incoming-message unit and its recognition duration in seconds. At exhausted voice quota no STT request is made; text remains independently usable. The buffer is cleared after recognition and never written to disk or Supabase. The resulting text is persisted by the normal message pipeline; raw media fields are removed. WAHA's own existing media cache is outside this backend's storage and was not changed under the provider restriction.

## Accounting and failure behavior

Paused inputs produce `message_observed` with `billable:false`, not message_received and not tenant_monthly_usage. Owner controls are also observations. Admitted customer inputs are message_received; separate voice_received seconds and stt_call attempts support cost accounting. Failed or low-confidence STT that results in a client explanation is still an attempted voice operation. Gemini answer/translation/classification calls remain model_call events. GET /api/admin/usage includes separate stt_calls and the existing model_calls.

admitUsage remains fail-open and logs error. Owner alerts use the tenant interval and a durable `.runtime/usage-alerts` local reservation, independent of Supabase and retained across PM2 restarts. Concurrent workers on the same VPS share it. A future multi-host deployment needs shared outage-independent throttling; this is a single-VPS implementation. Delivery failures and accounting/attribution failures are logged without messages or keys.

## Remaining fixed values and limits

Business defaults above are configurable. Fixed values that remain are protocol/schema invariants (status names, MIME/audio format handling, minute-to-second conversions, percentage scale, role names, API routes, allowed action names), security boundaries (no guessed facts, private incoming filtering, ownership checks), and technical constants in config (1-second scheduler wake-up, stale local lock recovery, local throttle path, default STT model overridable by env). Existing webhook/WAHA settings and command grammar were deliberately preserved as required. Templates are backend-only in this phase.

Automated verification covers build/types, actual HTTP auth behavior, SQL migration replay/RLS, runtime warning thresholds, tenant isolation, quoted owner workflow, quiet-hour timeout accounting, fail-open throttling, agent routing, STT/media contracts and a GOWS-derived audio fixture through the complete transcript/FAQ/agent/accounting pipeline. No real WhatsApp messages or production STT calls are sent during tests.

Verification result for migration 027: backend build/typecheck and 95 tests passed; admin build/lint/typecheck and 129 tests passed. Existing user edits in .env.example and unrelated Markdown files were preserved.

Migration applied successfully via Supabase apply_migration, recorded version `20260908174719`. Verified: only SELECT RLS policy remains on usage_events; authenticated cannot execute admission/settings-update RPCs, service_role can update settings. Backend commit c18096a; admin commit e035eda, both pushed. VPS restart and STT key installation remain deployment steps.

Post-apply check on 2026-09-09: aggregate RPC returned valid summaries for both existing tenants. Supabase security advisors reported the same pre-existing unrelated findings documented in [the prior security review](tenant-usage.md#verification-and-rollout), with no new findings for 026. They include public execution of `rls_auto_enable` ([remediation](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable)); those unrelated settings were left untouched.

Migration 027 was applied through Supabase apply_migration and recorded as `20260909041638_system_tenant_settings_and_calendar`. Production verification found zero legacy quiet-hour rows left without a weekly schedule. The new calendar table has RLS and tenant policies; the 026 notification columns are readable by authenticated members. Security advisors reported only the pre-existing findings above. Performance advisors include pre-existing unindexed foreign keys and unused indexes; the new calendar index is expected to remain unused until production calendar queries begin.
