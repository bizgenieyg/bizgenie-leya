begin;

-- Last known connected WhatsApp identity (canonical JID, e.g. 972501234567@c.us) for
-- the tenant's business session. `whatsapp_instances.phone` already exists but is a
-- legacy field from the manual onboarding step (onboarding.service.ts updateWhatsapp)
-- and is never written by the QR-pairing flow, so it does not reliably reflect which
-- account is actually connected. This column is the one the backend keeps in sync
-- with the real session identity, used to detect a business-number swap when a new
-- QR scan reconnects the session under a different WhatsApp account.
alter table public.whatsapp_instances
  add column if not exists connected_identity text;

commit;
