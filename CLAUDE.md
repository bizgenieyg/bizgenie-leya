# CLAUDE.md — Leia Project Instructions

Follow AGENTS.md.

## Required skills for Phase 1

Use relevant project skills:

- leia-architecture-guardian
- supabase-rls-migrations
- waha-whatsapp-provider
- express-typescript-backend
- security-secrets-reviewer
- phase-scope-enforcer
- context-loader-engine
- knowledge-faq-engine
- owner-notification-channel
- logging-observability-basic
- multi-tenant-data-model
- phase-1-test-scenarios

## Phase 1 hard boundary

If a request pushes into Booking, Payments, Email, History Scanner, CRM, Google Calendar, Admin Dashboard, or billing automation, create a TODO and stop. Do not implement it in Phase 1.

## Completion rule

After coding, run npm install, npm run build, npm run typecheck. If scripts are missing, create reasonable scripts in package.json. **Затем самостоятельно `git add`, `git commit` (описательный message) и `git push`** — не оставлять незакоммиченные файлы владельцу на ручную доводку. Исключение: действия с живой инфраструктурой (`supabase login`, `supabase db push`, деплой на сервер) — это всегда делает владелец вручную, не агент.

## Review rule (Claude Code в роли ревьюера)

При ревью диффа от Codex выполнять проверки самостоятельно через shell (git status/diff/grep/build/typecheck) — не просить владельца выполнять и вставлять вывод в чат. Отчёт владельцу — короткий pass/fail с конкретикой, не сырой вывод.
