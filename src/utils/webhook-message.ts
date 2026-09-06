import { extractMessageId } from "../providers/whatsapp/waha.provider.js";

const MESSAGE_EVENTS = new Set(["message", "message.any"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

/** `payload._data.Info.PushName` — the GOWS client display name. */
function readPushName(message: Record<string, unknown>): string | null {
  const data = asRecord(message._data);
  const info = data ? asRecord(data.Info) : null;
  const pushName = info ? info.PushName : undefined;
  return typeof pushName === "string" && pushName.trim() !== "" ? pushName : null;
}

/** `payload.replyTo.id` — the quoted message id, used for escalation reply matching. */
function readReplyToId(message: Record<string, unknown>): string | null {
  const replyTo = asRecord(message.replyTo);
  if (!replyTo) {
    return null;
  }
  const id = replyTo.id;
  return typeof id === "string" && id !== "" ? id : null;
}


export function normalizeWebhookMessage(body: Record<string, unknown>) {
  const event = readString(body, "event");
  const message = asRecord(body.payload) ?? (body.payload === undefined ? body : {});
  if (event !== "" && !MESSAGE_EVENTS.has(event)) return { kind: "ignored" as const };
  const from = readString(message, "from").trim();
  const text = readString(message, "body");
  if (!from) return { kind: "invalid" as const, reason: "missing_sender" };
  if (!text.trim()) return { kind: "invalid" as const, reason: "missing_text" };
  return { kind: "message" as const, from, text,
    incomingMsgId: extractMessageId(message.id) || null,
    replyToId: readReplyToId(message), fromMe: message.fromMe === true,
    pushName: readPushName(message) };
}

export function webhookEventType(body: Record<string, unknown>): string {
  const event = readString(body, "event");
  return ["message", "message.any", "session.status"].includes(event) ? event : "unknown";
}
