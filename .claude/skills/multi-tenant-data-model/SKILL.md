---
name: multi-tenant-data-model
description: Leia Phase 1 custom skill.
---

# multi-tenant-data-model

## Purpose

Use this skill only for Leia Phase 1 development.

## Universal Leia rules

- Follow `PRD/Leia_PRD_Final.md`.
- Follow `DevTask/Leia_Phase1_DevTask_Final.md`.
- Keep Phase 1 scope.
- Preserve tenant isolation.
- Preserve provider abstractions.
- Preserve Setup Layer.
- Do not expose secrets.
- Do not log API keys, webhook secrets, service role keys, or auth tokens.
- Do not implement Phase 2/3 features.

## Completion check

- No scope drift.
- No secret exposure.
- Acceptance criteria still pass.
