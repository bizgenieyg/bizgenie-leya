# Leya backend

Phase 1 Express and TypeScript backend skeleton with Supabase migrations.

## Requirements

- Node.js 20 or newer
- npm
- A Supabase project or local Supabase development environment

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and provide the backend-only credentials:

   ```bash
   cp .env.example .env
   ```

   `SUPABASE_SERVICE_ROLE_KEY` is a secret and must never be exposed to a frontend, committed, or logged.

   Generate `CREDENTIAL_ENCRYPTION_KEY` as a base64-encoded 32-byte key. `WAHA_URL` is read only from the environment; setup requests cannot override it.

   `WAHA_URL` and `WAHA_API_KEY` identify the single shared WAHA container.
   `PUBLIC_BASE_URL` is the public HTTPS origin WAHA uses for tenant webhooks.

3. Apply the SQL files in `supabase/migrations` in filename order using your Supabase migration workflow.

4. Start the development server:

   ```bash
   npm run dev
   ```

5. Check the health endpoint:

   ```bash
   curl http://localhost:3000/health
   ```

   Expected response: `{"status":"ok"}`.

## Validation

```bash
npm run build
npm run typecheck
npm test
```

RLS is enabled on every Phase 1 table. No public policies are created in this phase; database access is backend-only through the service-role client.

## Setup API

Create an onboarding session with `POST /admin/onboarding/create`. Authenticate using either `Authorization: Bearer <ADMIN_SECRET>` or `X-Admin-Secret`. The JSON body requires `name` and `phone`, with optional `business_name`. The response is the only time the seven-day setup token is returned; only its SHA-256 hash is stored.

Use the returned token with:

- `GET /setup/:token`
- `PATCH /setup/:token/business`
- `PATCH /setup/:token/assistant`
- `PATCH /setup/:token/knowledge` with `{ "items": [...] }`
- `PATCH /setup/:token/services` with `{ "items": [...] }`
- `PATCH /setup/:token/plan` with `subscription`, `addons`, `modules`, and optional `limits`
- `PATCH /setup/:token/whatsapp`
- `POST /setup/:token/test` with `{ "question": "..." }`
- `POST /setup/:token/complete`

Knowledge and services patches replace the tenant's existing setup rows. The test endpoint returns exact FAQ answers after case/whitespace normalization. Unknown questions return `escalate: true` and no generated answer.

## WhatsApp webhook

`POST /webhook/:tenantId` receives WAHA (GOWS engine) events.

Authentication runs before any processing:

- Primary: `X-Hub-Signature-256` — HMAC-SHA256 of the raw request body, keyed
  with the tenant's webhook secret (`sha256=<hex>` or bare `<hex>`).
- Fallback: `X-Webhook-Token` — the tenant's webhook secret sent verbatim.

The webhook secret is stored encrypted in `whatsapp_instances.webhook_secret_encrypted`
(written via `PATCH /setup/:token/whatsapp`). An unknown tenant, a tenant with no
configured secret, or a failed check all return `401` before the body is read.

On success the route stores nothing synchronously beyond acknowledging with
`200 { "received": true }`. A background worker then:

1. Ignores non-message events and `status@broadcast` (Status/Stories).
2. Resolves tenant → client → active conversation. Parses GOWS fields:
   text `payload.body`, sender `payload.from` (may be `@lid`), name
   `payload._data.Info.PushName`.
3. Persists the inbound message with its raw payload in `messages.raw_payload`.
4. Runs the Knowledge Module. Exact FAQ match → replies through the
   `WhatsAppProvider` and logs `faq_answer_exact`. No match → optional Gemini
   knowledge-grounded reply; disabled/failed Gemini → existing owner escalation.
5. Escalations go only to the separately configured owner in `notification_settings`.
   Quiet hours use the owner's configured IANA time zone; `scheduled_jobs`
   (`job_type = 'owner_escalation'`) persists deferred questions.
6. Outgoing/session-self messages remain discarded. Incoming messages from the
   separately verified business owner enter quoted-reply/learning/pause handling.

Deferred escalations are delivered by `runDueScheduledEscalations()` in
`src/services/owner-workflow.service.ts`. The backend checks the queue every
minute via `src/workers/escalation-scheduler.ts`; no external cron is required.

`WAHA_URL` is only ever read from the environment; provider logic lives in
`src/providers/whatsapp/` and business code depends on the `WhatsAppProvider`
interface, never on WAHA directly. `AIProvider` supplies the optional Gemini fallback after an exact FAQ miss.

## Basic weekly reports

Reports are backend-only and use the same `ADMIN_SECRET` authentication as the
admin onboarding route.

- `GET /admin/reports/weekly/:tenantId` returns the last seven days of message,
  new-client, and escalation counts plus the most frequent unknown questions.
  Use the optional `top_limit` query parameter (1–20, default 5).
- `POST /admin/reports/weekly/jobs` creates a pending `scheduled_jobs` row with
  `job_type = 'weekly_report'`. The body requires `tenant_id` and accepts an
  optional ISO `scheduled_at`; omission schedules it for the current time.

Phase 1 only prepares report data and job records. It does not execute,
schedule, format, or deliver weekly reports.

## WAHA session administration

All routes use `ADMIN_SECRET`. One shared WAHA container holds one deterministic
session per tenant, named `tenant-<tenantId>`:

- `POST /api/admin/waha/create` with `{ "tenantId": "<uuid>" }`
- `GET /api/admin/waha/qr?tenantId=<uuid>` returns the QR image with `no-store`
- `GET /api/admin/waha/status?tenantId=<uuid>`
- `POST /api/admin/waha/reconnect?tenantId=<uuid>` updates webhook configuration and restarts; logs out and recreates if still FAILED/STOPPED
- `POST /api/admin/waha/disconnect?tenantId=<uuid>` logs out, stops, then deletes

The WAHA API key stays server-side and is never returned by these endpoints.

### Webhook authentication and recovery deployment

Session creation saves a random per-tenant webhook secret encrypted in
`whatsapp_instances.webhook_secret_encrypted` **before** calling WAHA.
Existing secrets are reused; legacy NULL secrets are initialized on reconnect.
No new environment variable or SQL migration is required.

Server environment:
- `PUBLIC_BASE_URL=https://leya.bizgenie.site`
- `CREDENTIAL_ENCRYPTION_KEY`: the existing base64-encoded 32-byte encryption key.
  Keep its current value if encrypted credentials already exist. Only for an
  installation without a key, generate one using `openssl rand -base64 32` and
  save it privately in the server environment.
- `WAHA_URL`, `WAHA_API_KEY`, `ADMIN_SECRET`: existing server values, unchanged.

The provider sends `POST /api/sessions` with this body (placeholders below are
replaced at runtime; the secret is never returned by the admin API):

```json
{
  "name": "tenant-<tenantId>",
  "start": true,
  "config": {
    "markOnline": false,
    "webhooks": [{
      "url": "https://leya.bizgenie.site/webhook/<tenantId>",
      "events": ["message", "session.status"],
      "customHeaders": [{ "name": "X-Webhook-Token", "value": "<per-tenant-secret>" }]
    }],
    "metadata": { "tenant_id": "<tenantId>" }
  }
}
```

The webhook validator compares that token with the decrypted tenant secret.
Existing HMAC verification continues to use the exact raw bytes captured by
the Express JSON parser, including Cyrillic and Hebrew payloads.

Deploy in `/var/www/bizgenie-leya`:
`git pull && npm run build && pm2 restart leia-api --update-env`.

During environment migration the backend accepts `LEYA_API_URL` as the preferred
public base URL and `LEYA_ADMIN_API_KEY` as the preferred admin secret. Deprecated
`LEIA_API_URL` and `LEIA_ADMIN_API_KEY` remain stage-1 fallbacks and emit warnings
without values. Existing `PUBLIC_BASE_URL` and `ADMIN_SECRET` also remain supported
for the current VPS deployment. If both spellings are present, `LEYA_*` wins.
**Deployment alone does not update existing WAHA sessions.** Afterwards call
`POST /api/admin/waha/reconnect?tenantId=<uuid>` with the existing
`Authorization: Bearer <ADMIN_SECRET>` server credential for each affected tenant.
Reconnect stops the session, applies the configuration using PUT, and starts it.
If the session is still FAILED/STOPPED, it logs out, stops, deletes and recreates
it; this fallback requires scanning a new QR. A missing WAHA session is recreated.
Verify a real incoming message receives a response and webhook delivery returns
200 after deployment.

QR checks status first and returns HTTP 409 with `status` and `qrAvailable: false`
unless SCAN_QR_CODE. It rechecks state if fetching the QR fails during a
transition. Unreachable WAHA remains HTTP 502.

Contract reference: https://waha.devlike.pro/docs/how-to/sessions/
Regression checks: `npm run build && npm run typecheck && npm test` cover
webhook token/HMAC verification, encrypted-secret persistence before startup,
legacy-secret recovery, session configuration, reconnect fallback and FAQ routing.

### Versioned session status contract

The project operations notes identify **WAHA Core 2026.6.2 / GOWS**.
Verified against tag `2026.6.2`, commit
`208f4f3d78b15f68d9b17e78f5318c0e2ceb26de`:
- [WAHASessionStatus enum](https://github.com/devlikeapro/waha/blob/2026.6.2/src/structures/enums.dto.ts)
- [Session response/config DTOs](https://github.com/devlikeapro/waha/blob/2026.6.2/src/structures/sessions.dto.ts)
- [GOWS engine response](https://github.com/devlikeapro/waha/blob/2026.6.2/src/core/engines/gows/session.gows.core.ts)

The complete enum for that version is STOPPED, STARTING, SCAN_QR_CODE, WORKING,
FAILED. NOT_CREATED is our local absence marker, not a WAHA status. New unknown
status strings are preserved. Current unversioned WAHA documentation may include
statuses introduced after 2026.6.2; do not silently apply that enum to this version.

`GET /api/admin/waha/status` returns a flat object:
`{ session, status, qrAvailable, reason? }`. Only SCAN_QR_CODE enables QR.
There is no documented human-readable failure-reason field in SessionInfo for
this version; GOWS returns found/connected, or a technical engine.gows.error.
When that error is present for FAILED, we supply a fixed safe explanation instead
of forwarding its raw text. No reason is invented when WAHA supplies no error.

Create first reads the deterministic WAHA session. Existing sessions return
HTTP 200 with `created: false`; only WAHA HTTP 404 permits creation. A new session
returns HTTP 201 with `created: true`. A competing create is resolved with a
fresh status lookup. Transport/auth failures are not treated as absence.

Both admin screens use this behavior:
| Status | Display/action |
| --- | --- |
| NOT_CREATED (local) | Connect → create after status recheck |
| STOPPED | Disconnected → reconnect |
| STARTING | Connecting + spinner; poll; never create |
| SCAN_QR_CODE | Instructions + QR, refresh every 20 seconds |
| WORKING | Connected; Next in onboarding / Disconnect with confirmation in cabinet |
| FAILED | Failed + safe reason when available; reconnect |
| Any other string | Display verbatim; retry via reconnect |

Status polling is every 3 seconds for at most 3 minutes, stops at a terminal
state and on unmount. HTTP 4xx does not become “backend unavailable”.

#### Correction: markOnline on GOWS 2026.6.2

The outgoing POST /api/sessions body **does contain config.markOnline: false**;
the provider contract test captures and asserts the actual fetch body.
However, in this version `markOnline` is declared only in `NowebConfig`
(`config.noweb.markOnline`). Neither SessionConfig nor GowsConfig declares the
top-level field. The session controller's
[WAHAValidationPipe](https://github.com/devlikeapro/waha/blob/2026.6.2/src/nestjs/pipes/WAHAValidationPipe.ts)
uses `whitelist: true`, which strips it (or rejects it in strict mode).
Its absence from GET is therefore **not evidence of a hidden supported GOWS
setting**. The prior claim that this config controls GOWS phone notifications
was incorrect. The requested field remains in the outgoing body, but cannot
provide that guarantee in this version. Do not switch engines or add an
undocumented replacement setting.

Live version/config validation remains pending: SSH over the documented
Tailscale address timed out; the LAN address refused the available SSH key.
No live session was created or disconnected during these checks. Confirm the
running image version and notification behavior on the installed WAHA instance.

### GOWS worker null-field regression

The `Cannot read properties of null (reading 'replace')` failure is reproduced
by `digitsOf(tenant.phone)` when `tenants.phone` is NULL. Migration 004 makes
that column nullable, but TenantRow previously declared a required string.
A read-only aggregate confirmed a NULL phone in the deployed database. This
is a database field, not GOWS PushName; the nested PushName reader was already
null-safe. The other replace calls are URL cleanup (guarded server env) and FAQ
normalization (which first calls normalize on a validated string).

The worker now normalizes GOWS payloads before business processing. Null or
missing `from`/`body` is skipped with a warning containing only event type and
`missing_sender`/`missing_text`. Null optional `_data`, `Info`, `PushName`, `id`
and `replyTo` are accepted. Exact FAQ text normalization/search is unchanged.
A missing owner phone no longer blocks FAQ replies; unknown questions remain
stored, with `escalation_missing_owner_phone` instead of sending to an empty
address. Configure the owner's phone to enable escalation delivery.

Unhandled worker errors log event type, error type and stack frames. Error
messages and webhook bodies are excluded because they may contain secrets or
message text. Regression fixtures use a redacted GOWS-shaped payload, not
production contact/message contents. Tests also exercise the complete worker
with a NULL tenant phone and a deterministic FAQ answer.

After deploying (`git pull && npm run build && pm2 restart leia-api --update-env`),
send an exact existing FAQ question from another WhatsApp number: it should
receive the stored answer with no replace exception. A missing-text event should
produce `webhook_message_skipped`; an unknown question without an owner phone
should produce `webhook_escalation_skipped`. No SQL migration is required.

Worker failure diagnostics keep the immediate WAHA HTTP 200 acknowledgement:
processing failures do not request retries. Look for `webhook worker failed:`
in `pm2 logs leia-api --err`. Each error includes `level: error`, `tenantId`,
`eventId` (the WAHA envelope ULID), `event`, `errorType`, and all captured stack
frames with file/line locations. If WAHA omits a valid envelope id, a generated
UUID is labelled `eventIdSource: generated`. Message ids/bodies and error-message
contents are not substituted into the log. Stack capture has no frame-count cap.
An HTTP regression test forces a worker failure after successful authentication,
asserts HTTP 200, and verifies event correlation plus the failing call sites.


### Optional Gemini knowledge fallback

Set server-only `GEMINI_API_KEY` to your Google AI Studio API key. Without it,
fallback is disabled; startup and exact FAQ replies keep working. Optional
`GEMINI_MODEL` defaults to **gemini-3.5-flash-lite**, listed as stable in Google's
[model documentation](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite).
The provider uses [generateContent REST](https://ai.google.dev/api/generate-content)
with `x-goog-api-key`, a 10-second abort timeout, no retries and no added SDK.

Every message loads current tenant context using explicit tenant_id filters:
active FAQ question/answer pairs from knowledge_items, plus assistant_profiles
assistant_name, allowed_languages and tone (migration 001). Exact FAQ lookup is
unchanged and always runs first. Only a miss calls Gemini. Context is not shared
or cached between tenants. Tenant settings/client text are passed as JSON data,
with separate system instructions requiring knowledge-only answers, no invented
prices/terms/facts, the customer's Hebrew/Russian/English language, and 2–4 short
WhatsApp-style sentences without headings/lists. Prompt constraints are not a
deterministic guarantee of factuality; check representative answers before use.

Timeout, HTTP error, blocked/partial/empty output falls through to the existing
escalation/silence path, with only `gemini_fallback_unavailable` logged. Successful
replies follow the existing message persistence path and record a
`knowledge_ai_answer` action/usage event without copying full texts into those
logs. No changes to webhook authentication, WAHA provider, onboarding or schema.

Deploy with the existing git pull/build/PM2 restart --update-env procedure after
setting the key. Test one exact FAQ (no Gemini call), one paraphrase, and an
unknown fact (must say the knowledge is missing and suggest contacting owner).
Disable by removing GEMINI_API_KEY and restarting with --update-env.
The automated tests mock Gemini; a live model call remains to be checked after
setting the server key. No API key or customer data was sent during tests.


### Private-text gate and presentation allowlist

Verified against WAHA Core 2026.6.2 GOWS source:
[src/core/engines/gows/session.gows.core.ts](https://github.com/devlikeapro/waha/blob/2026.6.2/src/core/engines/gows/session.gows.core.ts).
`getFromToParticipant` reads `Info.Chat` into the chat `from`; WAHA publishes it
as `payload.from`. `payload.participant`/`Info.Sender` is the group participant,
not the chat. Group detection therefore uses `payload.from` ending in `@g.us`,
with `_data.Info.Chat` and `Info.IsGroup` as additional rejection signals.

After unchanged webhook authentication/HTTP 200, the route gates events before
starting the worker; the worker repeats the gate for direct calls. Only `message`
or `message.any`, no explicitly true outgoing flag, `hasMedia: false`, nonempty text and a
numeric private chat (`@c.us`, `@s.whatsapp.net` or `@lid`) are accepted. Groups, outgoing,
status/broadcast, newsletter/channel, system events, media captions, locations,
contacts and non-text protocol objects are ignored. Conflicting or unknown IDs,
except numeric private `@lid` JIDs, fail closed. No group participant fallback is used.
This cannot prove a remote human authored the text; it enforces incoming private
text according to WAHA's event fields.

Each rejection logs exactly one `webhook_ignored` line with chat type/event/reason,
without message text or phone number. Outgoing owner-reply relay is disabled.
The gate precedes FAQ, Gemini and any keyword handling.

Server configuration (disabled by default):
```
WHATSAPP_ALLOWLIST_ENABLED=true
WHATSAPP_ALLOWLIST_NUMBERS=972501234567,972509876543
```
Use your demo numbers in international format with country code. A leading `+`
and spaces/dashes are normalized; numbers without country codes are not expanded.
Enabled plus empty/invalid list blocks everyone. A nonempty unrecognized flag
also fails closed. Set `false` to disable. Restart PM2 with `--update-env` after
changing server env. No SQL migration is needed.

In allowlist mode owner escalation recipients and already-queued escalation
recipients are checked too. Blocked queued jobs stay pending and can be delivered
later if the policy permits them. Include the owner only if owner notifications
are intended during the demo. We do not start the stopped WAHA session.
Before manually resuming it, deploy and set the allowlist; verify an allowed
private message receives an answer, while group/fromMe/nonlisted messages log a
single rejection and cause no FAQ/Gemini/send calls.


### H-fix: opaque LID private chats

Numeric `payload.from` ending in `@lid` is a private chat, like `@c.us` and
`@s.whatsapp.net`. Group/broadcast/newsletter and fromMe protections remain.
With allowlist disabled it reaches the existing FAQ/Gemini flow. No lookup or
conversion from LID to a telephone number is attempted.

The full LID (including `@lid`) is used in the existing clients.phone key column
and therefore the client/conversation/escalation chain. Reply destinations retain
the full JID. Phone-number keys remain unchanged. A LID is never compared with an
owner phone based only on matching digits. No existing ambiguous numeric client
records are rewritten or guessed. Context remains scoped by tenant_id.
There is no “АУДИТ” promotion implementation in this checkout to update.

When allowlist is enabled, unresolved LIDs are blocked with
`allowlist_unresolved`, even if the LID's digits appear in the phone list.
Rejection reasons: `system_event`, `non_private_chat`, `conflicting_chat`,
`outgoing_message`, `non_text`, `missing_text`,
`allowlist_unresolved`, `not_allowlisted`; the worker also ignores identified
owners with `owner_message`. An unknown chat logs its suffix only (e.g.
`@future`), not the number. LIDs are labelled `private`, not `unknown`.

Tests cover private LID FAQ and Gemini replies, complete LID client keys and
reply addresses, groups, fromMe, and allowlist rejection. No env or migration
changes. The stopped WAHA session is not started by this change.


### H-fix-2: direction is explicit, ownership is separate

The full real incoming LID payload in messages.raw_payload identified WAHA
**2026.7.2 / GOWS**, with `payload.fromMe=false`,
`payload._data.Info.IsFromMe=false`, and **`payload.source="app"`**. The old
source check incorrectly discarded this incoming message. This was not caused
by comparing LID digits with the owner. The fix removes source and missing-flag
inference entirely. Both field names were also checked against the
[2026.7.2 GOWS source](https://github.com/devlikeapro/waha/blob/2026.7.2/src/core/engines/gows/session.gows.core.ts).

Only boolean true in `payload.fromMe` or `_data.Info.IsFromMe` means outgoing.
False, absent or null direction flags pass this check. Source and identifier
comparisons do not determine direction. Media/group/allowlist checks still apply.

Ownership is checked separately against both current session `me.id` and `me.lid`
from GET /api/sessions/{session}, through the existing provider abstraction.
The lookup has a 10-second timeout. The authenticated webhook's me is used as a
fallback when the lookup fails/omits identity. Matching phone JIDs normalize
@s.whatsapp.net to @c.us; LIDs stay opaque and are never resolved to numbers.
A match gives `owner_message`. Missing identity never changes direction to
outgoing. Session identity is not returned through the normalized admin status API.

All policy rejection logs now include `field` and a safe `value`: a boolean,
suffix, or fixed marker such as `matched`, `mismatch`, `missing_or_empty`.
No sender number, message text or full payload is logged.
Each `webhook_ignored` also includes `diagnostics` keyed by payload field path:
direction booleans/nulls, field presence and type, source (`app`/`api` only),
sender/chat and webhook/session owner identity suffixes. Unexpected flag values
are redacted; absent fields remain distinguishable from null. This evidence is
included even when an earlier group or allowlist check rejects the message.
Full reason list: `system_event`, `non_private_chat`, `conflicting_chat`,
`outgoing_message`, `non_text`, `missing_text`, `allowlist_unresolved`,
`not_allowlisted`, `owner_message`.

Complete real private/group payload structures are saved as redacted fixtures
under src/services/fixtures. They preserve flags, source, nulls and nested keys;
identifiers and text are replaced. Tests exercise the entire private payload
through every filter, normalization and worker FAQ reply, plus owner id/lid,
missing direction flags and all group/fromMe/allowlist protections.
No webhook authentication, onboarding or database schema changes. Deploy with
existing git pull/build/PM2 --update-env procedure; no new env variables.
Allowlist still intentionally rejects unresolved LIDs when enabled.

## Эскалации, обучение и участие владельца

Реализован полный цикл вопрос → реплей владельца → отправка клиенту → подтверждение сохранения в FAQ. Настройка отдельного номера владельца и тихих часов: `/onboarding/owner` после подключения WhatsApp. Команды: «Пауза всё», «Продолжить всё», «Диалоги»; реплеем на вопрос — «Беру на себя», «Пауза», «Продолжить».

Подробное сравнение с chef-bot, схема, команды, ограничения доставки и порядок проверки: [docs/owner-escalation-port.md](docs/owner-escalation-port.md). Перед деплоем применить миграцию [024](supabase/migrations/20260908114713_024_owner_escalation_workflow.sql). Новых переменных окружения нет. Очередь работает внутри бэкенда раз в минуту, время — часовой пояс владельца из настроек.

### Tenant usage and monthly limits

See [usage accounting, limits API, SQL and rollout](docs/tenant-usage.md). Monthly quotas count incoming customer messages; outgoing messages and Gemini token usage are tracked separately. No new environment variables are needed.

### Runtime settings, agents and voice (review fixes)

See [review report, defaults, STT choice, SQL and rollout](docs/review-runtime-settings.md). Configure tenant behavior in `/admin/settings`; templates and advanced runtime settings are also available through the backend API. Speech recognition requires server `STT_API_KEY`; `STT_MODEL` is optional.
