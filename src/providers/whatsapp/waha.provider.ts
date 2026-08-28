import type {
  SendMessageInput,
  SendMessageResult,
  SessionStatus,
  WhatsAppProvider,
} from "./whatsapp-provider.interface.js";

/**
 * WAHA (GOWS engine) implementation of {@link WhatsAppProvider}.
 *
 * The base URL is injected (env-only, never hardcoded). The API key is optional
 * so callers can pass a per-tenant key or fall back to a shared one.
 */
export class WahaProvider implements WhatsAppProvider {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly apiKey?: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const body: Record<string, unknown> = {
      session: input.session,
      chatId: input.chatId,
      text: input.text,
    };
    if (input.replyTo) {
      body.reply_to = input.replyTo;
    }

    const data = await this.request("POST", "/api/sendText", body);
    return { id: extractMessageId(data) };
  }

  async getSessionStatus(session: string): Promise<SessionStatus> {
    const data = await this.request(
      "GET",
      `/api/sessions/${encodeURIComponent(session)}`,
    );
    const record = isRecord(data) ? data : {};
    const engine = isRecord(record.engine) ? record.engine : {};
    const gows = isRecord(engine.gows) ? engine.gows : {};
    const result: SessionStatus = {
      status: typeof record.status === "string" ? record.status : "unknown",
    };
    if (typeof gows.connected === "boolean") {
      result.connected = gows.connected;
    }
    return result;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) {
      headers["X-Api-Key"] = this.apiKey;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      // Never surface the response body: it can echo the API key back.
      throw new Error(`WAHA ${method} ${path} failed with status ${response.status}`);
    }

    const text = await response.text();
    if (text.trim() === "") {
      return {};
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return {};
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * WAHA returns the sent-message id in a few shapes depending on engine/version:
 * a bare string, `{ id: "..." }`, or `{ id: { _serialized: "..." } }`.
 */
export function extractMessageId(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return "";
  }
  const id = value.id;
  if (typeof id === "string") {
    return id;
  }
  if (isRecord(id)) {
    if (typeof id._serialized === "string") {
      return id._serialized;
    }
    if (typeof id.id === "string") {
      return id.id;
    }
  }
  return "";
}
