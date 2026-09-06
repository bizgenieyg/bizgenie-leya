import { env } from "../config/env.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export type AllowlistPolicy = { enabled: boolean; numbers: ReadonlySet<string> };
export function parseAllowlist(flag?: string, list?: string): AllowlistPolicy {
  // Invalid nonempty flags fail closed rather than silently disabling protection.
  const enabled = !!flag?.trim() && !["false", "0"].includes(flag.trim().toLowerCase());
  const numbers = new Set((list ?? "").split(",").map(number => number.trim())
    .filter(number => /^\+?[\d ()-]+$/.test(number))
    .map(number => number.replace(/\D/g, "")).filter(number => /^\d{7,15}$/.test(number)));
  return { enabled, numbers };
}
export function currentAllowlist() { return parseAllowlist(env.whatsappAllowlistEnabled, env.whatsappAllowlistNumbers); }
export function allowedRecipient(value: unknown, policy = currentAllowlist()): boolean {
  if (typeof value !== "string") return false;
  const match = /^(\d{7,15})@(c\.us|s\.whatsapp\.net)$/.exec(value);
  const number = match?.[1] ?? (/^\+?[\d ()-]+$/.test(value) ? value.replace(/\D/g, "") : "");
  if (!/^\d{7,15}$/.test(number)) return false;
  return !policy.enabled || policy.numbers.has(number);
}
export function filterIncoming(body: Record<string, unknown>, policy = currentAllowlist()) {
  const event = typeof body.event === "string" && ["message", "message.any"].includes(body.event) ? body.event : "other";
  const message = record(body.payload);
  const info = record(record(message._data).Info);
  const from = typeof message.from === "string" ? message.from : "";
  const rawChat = typeof info.Chat === "string" ? info.Chat : "";
  const chatType = [from, rawChat].some(chat => chat.endsWith("@g.us")) || info.IsGroup === true ? "group"
    : [from, rawChat].some(chat => chat.endsWith("@broadcast")) ? "broadcast"
    : [from, rawChat].some(chat => chat.endsWith("@newsletter")) ? "newsletter"
    : /^\d{7,15}@(c\.us|s\.whatsapp\.net)$/.test(from) ? "private" : "unknown";
  const reject = (reason: string) => ({ allowed: false as const, chatType, event, reason });
  if (event === "other") return reject("system_event");
  if (chatType !== "private") return reject("non_private_chat");
  if (rawChat && rawChat.replace(/@s\.whatsapp\.net$/, "@c.us") !== from.replace(/@s\.whatsapp\.net$/, "@c.us")) return reject("conflicting_chat");
  if (message.fromMe !== false || info.IsFromMe === true || (message.source != null && message.source !== "")) return reject("outgoing_or_unknown_direction");
  if (message.hasMedia !== false || message.media || message.mediaUrl || message.location || (Array.isArray(message.vCards) && message.vCards.length)) return reject("non_text");
  if (typeof message.body !== "string" || !message.body.trim()) return reject("missing_text");
  const raw = record(record(message._data).Message);
  if (Object.keys(raw).length && !Object.keys(raw).filter(key => raw[key] != null).every(key => ["conversation", "extendedTextMessage", "messageContextInfo"].includes(key))) return reject("non_text");
  if (!allowedRecipient(from, policy)) return reject("not_allowlisted");
  return { allowed: true as const, chatType, event };
}
export function logRejectedIncoming(result: ReturnType<typeof filterIncoming>) {
  console.info(`webhook_ignored ${JSON.stringify(result)}`);
}
