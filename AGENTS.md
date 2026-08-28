# AGENTS.md — Leia Project Instructions

## Project

Leia is a multi-tenant WhatsApp AI assistant platform for small businesses in Israel.

## Current phase

Phase 1 only.

## In scope

Express + TypeScript backend, Supabase migrations, Setup Layer, WAHA GOWS webhook, tenant routing, Knowledge Module, Escalation (with quiet hours mute_all + reply-id matching), minimal logs, minimal usage events.

## Out of scope

Do not implement Booking, Payments, Email, History Scanner, CRM, Full Admin Dashboard, Google Calendar, Morning/GreenInvoice, Marketing campaigns, Voice/OCR, Billing automation, multi-staff routing (`tenant_staff`), mixed-line contact classification.

## Architecture rules

- Every business table must include `tenant_id`.
- Use `WhatsAppProvider` interface.
- Use `AIProvider` interface.
- Do not hardcode WAHA into business logic. `WAHA_URL` only via env.
- Keep routes, services, providers, workers separate.
- Unknown questions escalate; do not hallucinate.
- Setup token stored as hash only.
- Webhook validates HMAC or token before processing.
- Raw webhook payload is stored.
- Backend only may use Supabase service role.
- Frontend never receives service role.
- No secrets in repo, README, logs, or screenshots.

## Quality gates

Before finishing: npm install, npm run build, npm run typecheck if configured, migrations exist, RLS enabled, .env.example exists, README explains setup and tests, invalid webhook returns 401, exact FAQ returns answer, unknown question escalates.
