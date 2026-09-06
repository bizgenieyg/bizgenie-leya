# Leia backend

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
   `WhatsAppProvider` and logs `faq_answer_exact`. No match → creates an owner
   escalation and logs `escalation_created`.
5. Escalations go to `tenants.phone`. Inside `notification_settings` quiet hours
   (only `mode = 'mute_all'`), delivery is deferred into `scheduled_jobs`
   (`job_type = 'escalation_delivery'`) instead of sending immediately.
6. An owner reply is relayed to the client only when `payload.replyTo.id`
   matches the stored WAHA message id of the escalation we sent.

Deferred escalations are delivered by `runDueScheduledEscalations()` in
`src/services/escalation.service.ts`. It is not run by the web process — wire it
to a PM2 cron or external scheduler (e.g. once per minute).

`WAHA_URL` is only ever read from the environment; provider logic lives in
`src/providers/whatsapp/` and business code depends on the `WhatsAppProvider`
interface, never on WAHA directly. `AIProvider` is a Phase 1 placeholder and is
not wired into the pipeline.

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
