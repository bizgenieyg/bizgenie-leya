/**
 * Helpers for WhatsApp / WAHA identifiers.
 *
 * WAHA `payload.from` is a JID such as `972500000000@c.us`, `972...@s.whatsapp.net`
 * or `12345@lid`. `tenants.phone` is a human-entered number like `+972 50-000-0000`.
 */

/** Strip the `@domain` suffix, keeping the raw local part (may be a `@lid` id). */
export function stripJidSuffix(jid: string): string {
  const at = jid.indexOf("@");
  return at === -1 ? jid : jid.slice(0, at);
}

/** Digits only — used to compare a JID against a human-entered phone number. */
export function digitsOf(value: string): string {
  return value.replace(/\D+/g, "");
}

/** True for WhatsApp Status / Stories broadcasts, which must be ignored. */
export function isStatusBroadcast(from: string): boolean {
  return from === "status@broadcast" || from.startsWith("status@");
}

/**
 * Turn a phone number or JID into a chat id WAHA accepts.
 * Already-qualified JIDs pass through unchanged.
 */
export function toChatId(phoneOrJid: string): string {
  if (phoneOrJid.includes("@")) {
    return phoneOrJid;
  }
  return `${digitsOf(phoneOrJid)}@c.us`;
}
