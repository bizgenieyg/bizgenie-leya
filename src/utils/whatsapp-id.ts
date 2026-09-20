/**
 * Helpers for WhatsApp / WAHA identifiers.
 *
 * WAHA `payload.from` is a JID such as `972500000000@c.us`, `972...@s.whatsapp.net`
 * or `12345@lid`. `tenants.phone` is a human-entered number like `+972 50-000-0000`.
 */

/** Strip the `@domain` suffix, keeping the raw local part (may be a `@lid` id). */
export function stripJidSuffix(jid: unknown): string {
  if (typeof jid !== "string") return "";
  const at = jid.indexOf("@");
  return at === -1 ? jid : jid.slice(0, at);
}

/** Digits only — used to compare a JID against a human-entered phone number. */
export function digitsOf(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\D+/g, "");
}

/**
 * Normalize an Israeli phone number to the international form WhatsApp needs:
 * `972` + the 9-digit subscriber number, no leading trunk `0`, no separators.
 * Ported from the proven normalization in bni-synergy (services/db.js
 * `normalizePhone`) rather than written from scratch.
 *
 * Accepts local (`0523695741`), bare (`523695741`) or already-international
 * (`972523695741`) input — idempotent either way. Returns `null` when the
 * digits don't resolve to a plausible 9-digit Israeli number, so callers can
 * reject the input with a clear error instead of building a JID that does
 * not exist on WhatsApp (the bug: `0523695741` silently became
 * `0523695741@c.us`, and the confirmation code never arrived).
 */
export function normalizeIsraeliPhone(value: unknown): string | null {
  let digits = digitsOf(value);
  if (digits.startsWith("972")) digits = digits.slice(3);
  else if (digits.startsWith("0")) digits = digits.slice(1);
  return /^\d{9}$/.test(digits) ? `972${digits}` : null;
}

/** Normalize new owner input only when an international country code is explicit. */
export function normalizeInternationalPhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const input = value.trim();
  if (!/^(?:\+|00)?[\d\s().-]+$/.test(input)) return null;
  const explicitPrefix = input.startsWith("+") || input.startsWith("00");
  let digits = digitsOf(input);
  if (input.startsWith("00")) digits = digits.slice(2);
  // Bare canonical values are accepted for compatibility with forms populated from
  // storage, but 9-10 digit local formats are never assigned a country implicitly.
  if (!explicitPrefix && digits.length < 11) return null;
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

/** True for WhatsApp Status / Stories broadcasts, which must be ignored. */
export function isStatusBroadcast(from: unknown): boolean {
  if (typeof from !== "string") return false;
  return from === "status@broadcast" || from.startsWith("status@");
}

/**
 * Turn a phone number or JID into a chat id WAHA accepts.
 * Already-qualified JIDs pass through unchanged. A raw number is normalized
 * as Israeli first (see `normalizeIsraeliPhone`) so a local-format number
 * (`0523695741`) resolves to the same JID as its international form
 * (`972523695741@c.us`) instead of an address that does not exist on
 * WhatsApp; anything that doesn't look like an Israeli number falls back to
 * the previous behavior (raw digits) rather than being rejected outright.
 */
export function toChatId(phoneOrJid: unknown): string {
  if (typeof phoneOrJid !== "string" || !phoneOrJid.trim()) return "";
  if (phoneOrJid.includes("@")) {
    return phoneOrJid;
  }
  const israeli = normalizeIsraeliPhone(phoneOrJid);
  if (israeli) return `${israeli}@c.us`;
  const digits = digitsOf(phoneOrJid);
  return digits ? `${digits}@c.us` : "";
}

/** LIDs are opaque identifiers, never phone numbers; preserve their namespace. */
export function senderKey(jid: string): string {
  return jid.endsWith("@lid") ? jid : stripJidSuffix(jid);
}
