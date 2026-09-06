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
// Keep diagnostic evidence useful without copying arbitrary payload strings or JIDs.
export function incomingDiagnostics(body: Record<string, unknown>, sessionMe?: SessionIdentity) {
  const message = record(body.payload);
  const info = record(record(message._data).Info);
  const presence = (object: Record<string, unknown>, key: string) => ({
    present: Object.prototype.hasOwnProperty.call(object, key),
    type: object[key] === null ? "null" : typeof object[key],
  });
  const flag = (object: Record<string, unknown>, key: string) => ({
    ...presence(object, key),
    value: typeof object[key] === "boolean" || object[key] === null ? object[key] : "absent_or_invalid",
  });
  const jid = (object: Record<string, unknown>, key: string) => {
    const value = object[key];
    const suffix = typeof value === "string" ? value.slice(value.lastIndexOf("@")) : "";
    return { ...presence(object, key), suffix: /^@[a-z.-]{1,64}$/i.test(suffix) ? suffix : "missing_or_invalid" };
  };
  return {
    "payload.fromMe": flag(message, "fromMe"),
    "payload._data.Info.IsFromMe": flag(info, "IsFromMe"),
    "payload.source": { ...presence(message, "source"), value: ["app", "api"].includes(String(message.source)) ? message.source : "absent_or_other" },
    "payload.from": jid(message, "from"),
    "payload._data.Info.Chat": jid(info, "Chat"),
    "payload._data.Info.Sender": jid(info, "Sender"),
    "payload._data.Info.IsGroup": flag(info, "IsGroup"),
    "me.id": jid(record(body.me), "id"),
    "me.lid": jid(record(body.me), "lid"),
    ...(sessionMe ? { "session.me.id": jid(sessionMe, "id"), "session.me.lid": jid(sessionMe, "lid") } : {}),
  };
}
export function allowedRecipient(value: unknown, policy = currentAllowlist()): boolean {
  if (typeof value !== "string") return false;
  if (/^\d+@lid$/.test(value)) return !policy.enabled;
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
    : (/^\d{7,15}@(c\.us|s\.whatsapp\.net)$/.test(from) || /^\d+@lid$/.test(from)) ? "private" : "unknown";
  const suffix = from.includes("@") ? from.slice(from.lastIndexOf("@")) : "missing";
  const safeSuffix = /^@[a-z0-9.-]{1,64}$/i.test(suffix) ? suffix : "missing_or_invalid";
  const reject = (reason: string, field: string, value: string | boolean) => ({ allowed: false as const, chatType, event, reason, field, value, diagnostics: incomingDiagnostics(body),
    ...(chatType === "unknown" ? { suffix: safeSuffix } : {}) });
  if (event === "other") return reject("system_event", "event", event);
  if (chatType !== "private") {
    const fromSuffix = from.slice(from.lastIndexOf("@"));
    const rawSuffix = rawChat.slice(rawChat.lastIndexOf("@"));
    if (["@g.us", "@broadcast", "@newsletter"].includes(fromSuffix)) return reject("non_private_chat", "payload.from", fromSuffix);
    if (["@g.us", "@broadcast", "@newsletter"].includes(rawSuffix)) return reject("non_private_chat", "payload._data.Info.Chat", rawSuffix);
    if (info.IsGroup === true) return reject("non_private_chat", "payload._data.Info.IsGroup", true);
    return reject("non_private_chat", "payload.from", safeSuffix);
  }
  if (rawChat && rawChat.replace(/@s\.whatsapp\.net$/, "@c.us") !== from.replace(/@s\.whatsapp\.net$/, "@c.us")) return reject("conflicting_chat", "payload.from / payload._data.Info.Chat", "mismatch");
  // GOWS source="app" also occurs on incoming messages. Only explicit flags
  // determine direction, never source, JIDs or absent/null flags.
  if (message.fromMe === true) return reject("outgoing_message", "payload.fromMe", true);
  if (info.IsFromMe === true) return reject("outgoing_message", "payload._data.Info.IsFromMe", true);
  if (message.hasMedia !== false || message.media || message.mediaUrl || message.location || (Array.isArray(message.vCards) && message.vCards.length)) return reject("non_text", "payload.media / hasMedia / location / vCards", "non_text_or_unknown");
  if (typeof message.body !== "string" || !message.body.trim()) return reject("missing_text", "payload.body", "missing_or_empty");
  const raw = record(record(message._data).Message);
  if (Object.keys(raw).length && !Object.keys(raw).filter(key => raw[key] != null).every(key => ["conversation", "extendedTextMessage", "messageContextInfo"].includes(key))) return reject("non_text", "payload._data.Message", "unsupported_type");
  if (policy.enabled && from.endsWith("@lid")) return reject("allowlist_unresolved", "payload.from", "@lid");
  if (!allowedRecipient(from, policy)) return reject("not_allowlisted", "WHATSAPP_ALLOWLIST_NUMBERS", "no_match");
  return { allowed: true as const, chatType, event };
}
export function logRejectedIncoming(result: ReturnType<typeof filterIncoming>) {
  console.info(`webhook_ignored ${JSON.stringify(result)}`);
}

export type SessionIdentity = { id?: string; lid?: string };
export function readSessionIdentity(value: unknown): SessionIdentity {
  const me = record(value);
  return {
    ...(typeof me.id === "string" && /^\d+@(c\.us|s\.whatsapp\.net)$/.test(me.id) ? { id: me.id } : {}),
    ...(typeof me.lid === "string" && /^\d+@lid$/.test(me.lid) ? { lid: me.lid } : {}),
  };
}
export function ownerIdentityField(from: string, me: SessionIdentity): string | null {
  const canonical = (id: string) => id.replace(/@s\.whatsapp\.net$/, "@c.us");
  if (me.id && canonical(from) === canonical(me.id)) return "session.me.id";
  if (me.lid && from === me.lid) return "session.me.lid";
  return null;
}
