begin;

-- Revert of migration 047 (20260917193000_047_merge_duplicate_client_jids.sql), forward-only
-- per policy: applied migrations are never edited or deleted.
--
-- 047 permanently merged public.clients rows that shared (tenant_id, normalized
-- WhatsApp JID digits, lower(name)): it re-pointed conversations/client_profiles to a
-- "keeper" row and then HARD-DELETED the "duplicate" row. The owner flagged this as
-- unsafe: within one tenant, two genuinely different real contacts can share a display
-- name (e.g. a personal WhatsApp account and an unrelated group both named the same
-- thing), and merging on name is not reversible once the duplicate row is gone — there
-- is no soft-delete or audit copy of what 047 removed.
--
-- The application-level revert is in src/services/tenant.service.ts:findOrCreateClient,
-- which no longer performs any name-based fallback match (back to an exact whatsapp_jid
-- lookup only, as it was before commit e5025bc). That is the actual fix going forward.
--
-- This migration changes nothing at the row level: there is nothing left to revert —
-- rows 047 deleted cannot be reconstructed by any migration, forward or otherwise. If a
-- specific tenant's pre-047 client data must be recovered, that requires a Supabase
-- point-in-time restore to before 047 ran; this is an owner decision, not something an
-- agent or migration can do. This file exists solely so `supabase migration list` /
-- history records the policy reversal at the point it happened.
--
-- Reliable de-duplication of contacts that share a real person but different
-- whatsapp_jid values (e.g. a WhatsApp Web @lid session vs the phone's @c.us JID) is a
-- separate, later piece of work using a sturdier signal than name — not this migration.

commit;
