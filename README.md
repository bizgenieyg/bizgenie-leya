# Leia backend

Phase 1 Express and TypeScript backend skeleton with Supabase migrations.

## Requirements

- Node.js 22 or newer
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
