# AGENTS.md — Leya Project Instructions

## Project

Leya is a multi-tenant WhatsApp AI assistant platform for small businesses in Israel.

## Current phase

Phase 1 only.

## In scope

Express + TypeScript backend, Supabase migrations, Setup Layer, WAHA GOWS webhook, tenant routing, Knowledge Module, Escalation (with quiet hours mute_all + reply-id matching), minimal logs, minimal usage events.

## Out of scope

Do not implement Booking, Payments, Email, History Scanner (bulk scan of chats to draft FAQ/profiles/classifications). Allowed by owner decision 2026-09-23: on first contact, read recent messages of that same chat from WAHA into model context only, not stored. Also out of scope: CRM, Google Calendar, Morning/GreenInvoice, Marketing campaigns, OCR, Billing automation, multi-staff routing (`tenant_staff`), mixed-line contact classification.

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
