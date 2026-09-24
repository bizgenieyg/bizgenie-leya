import { SessionNotFoundError } from "./whatsapp-provider.interface.js";
import type {
  WhatsAppChatMessage,
  SendMessageInput,
  SendMessageResult,
  SessionStatus,
  StartSessionInput,
  WhatsAppProvider,
  WhatsAppGroup,
  WhatsAppChatActivity,
  WhatsAppSessionProvider,
} from "./whatsapp-provider.interface.js";

/**
 * WAHA (GOWS engine) implementation of {@link WhatsAppProvider}.
 *
 * The shared-container base URL and API key are injected from backend env.
 */
export class WahaProvider implements WhatsAppProvider, WhatsAppSessionProvider {
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

    const data = await this.request("POST", "/api/sendText", body);
    return { id: extractMessageId(data) };
  }

  async sendSeen(input: { session: string; chatId: string; messageIds?: string[] }): Promise<void> {
    await this.request('POST', '/api/sendSeen', { session: input.session, chatId: input.chatId,
      ...(input.messageIds?.length ? { messageIds: input.messageIds } : {}) });
  }

  async startTyping(input: { session: string; chatId: string }): Promise<void> {
    await this.request('POST', '/api/startTyping', input);
  }

  async stopTyping(input: { session: string; chatId: string }): Promise<void> {
    await this.request('POST', '/api/stopTyping', input);
  }

  async getSessionStatus(session: string): Promise<SessionStatus> {
    let data: unknown;
    try {
      data = await this.request("GET", `/api/sessions/${encodeURIComponent(session)}`, undefined, AbortSignal.timeout(10000));
    } catch (error) {
      if (error instanceof WahaHttpError && error.status === 404) throw new SessionNotFoundError();
      throw error;
    }
    const record = isRecord(data) ? data : {};
    const engine = isRecord(record.engine) ? record.engine : {};
    const gows = isRecord(engine.gows) ? engine.gows : {};
    const result: SessionStatus = {
      status: typeof record.status === "string" ? record.status : "unknown",
    };
    const me = isRecord(record.me) ? record.me : {};
    result.me = {
      ...(typeof me.id === "string" ? { id: me.id } : {}),
      ...(typeof me.lid === "string" ? { lid: me.lid } : {}),
    };
    if (result.status === "FAILED" && gows.error) {
      // WAHA exposes a technical gRPC error, not a safe user-facing message.
      result.reason = "waha_status_unavailable";
    }
    if (typeof gows.connected === "boolean") {
      result.connected = gows.connected;
    }
    return result;
  }

  async startSession(input: StartSessionInput): Promise<SessionStatus> {
    const data = await this.request("POST", "/api/sessions", { ...input, start: true });
    const record = isRecord(data) ? data : {};
    return {
      status: typeof record.status === "string" ? record.status : "unknown",
    };
  }

  async restartSession(input: StartSessionInput): Promise<SessionStatus> {
    const path = `/api/sessions/${encodeURIComponent(input.name)}`;
    try {
      await this.stopSession(input.name);
      await this.request("PUT", path, input);
      await this.request("POST", `${path}/start`);
    } catch (error) {
      if (error instanceof WahaHttpError && error.status === 404) {
        return this.startSession(input);
      }
      if (error instanceof WahaHttpError && [401, 403].includes(error.status)) throw error;
      // Only attempt destructive recovery for a confirmed failed session.
      const current = await this.getSessionStatus(input.name);
      if (current.status === "FAILED" || current.status === "STOPPED") return current;
      throw error;
    }
    return this.getSessionStatus(input.name);
  }

  async stopSession(session: string): Promise<void> {
    await this.request(
      "POST",
      `/api/sessions/${encodeURIComponent(session)}/stop`,
    );
  }

  async logoutSession(session: string): Promise<void> {
    await this.request(
      "POST",
      `/api/sessions/${encodeURIComponent(session)}/logout`,
    );
  }

  async deleteSession(session: string): Promise<void> {
    await this.request(
      "DELETE",
      `/api/sessions/${encodeURIComponent(session)}`,
    );
  }

  async getQrImage(session: string): Promise<{ data: Buffer; contentType: string }> {
    const response = await this.fetchResponse(
      "GET",
      `/api/${encodeURIComponent(session)}/auth/qr?format=image`,
      undefined,
      "image/png",
    );
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("image/")) {
      throw new Error("WAHA QR endpoint returned a non-image response");
    }
    return {
      data: Buffer.from(await response.arrayBuffer()),
      contentType,
    };
  }

  async getGroups(session: string): Promise<WhatsAppGroup[]> {
    const data = await this.request(
      "GET",
      `/api/${encodeURIComponent(session)}/groups?sortBy=subject&sortOrder=asc`,
      undefined,
      AbortSignal.timeout(15000),
    );
    const values = Array.isArray(data)
      ? data
      : isRecord(data)
        ? Object.entries(data).map(([id, value]) => isRecord(value) ? { id, ...value } : value)
        : [];
    return values.flatMap(normalizeGroup);
  }

  async getChats(session: string, options: { limit: number; offset: number; sortBy: "conversationTimestamp"; sortOrder: "desc" }): Promise<WhatsAppChatActivity[]> {
    const params = new URLSearchParams({
      limit: String(options.limit), offset: String(options.offset),
      sortBy: options.sortBy, sortOrder: options.sortOrder,
    });
    const data = await this.request("GET", `/api/${encodeURIComponent(session)}/chats?${params}`, undefined, AbortSignal.timeout(15000));
    if (!Array.isArray(data)) throw new Error("WAHA chats endpoint returned a non-array response");
    return data.flatMap((value): WhatsAppChatActivity[] => {
      if (!isRecord(value) || typeof value.id !== "string") return [];
      const timestamp = value.conversationTimestamp;
      return [{ id: value.id, ...(typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0
        ? { conversationTimestamp: timestamp } : {}) }];
    });
  }

  async getChatMessages(session: string, chatId: string, options: { limit: number; timeoutMs: number }): Promise<WhatsAppChatMessage[]> {
    const params = new URLSearchParams({ limit: String(options.limit), offset: "0", downloadMedia: "false" });
    const data = await this.request("GET", `/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(chatId)}/messages?${params}`, undefined, AbortSignal.timeout(options.timeoutMs));
    if (!Array.isArray(data)) throw new Error("WAHA chat messages endpoint returned a non-array response");
    return data.flatMap((value): WhatsAppChatMessage[] => {
      if (!isRecord(value) || typeof value.id !== "string" || typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp)) return [];
      return [{ id: value.id, timestamp: value.timestamp, fromMe: value.fromMe === true,
        body: typeof value.body === "string" ? value.body : "", hasMedia: value.hasMedia === true }];
    });
  }

  private async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: object,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.fetchResponse(method, path, body, "application/json", signal);
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

  private async fetchResponse(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body: object | undefined,
    accept: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const headers: Record<string, string> = { Accept: accept };
    if (this.apiKey) {
      headers["X-Api-Key"] = this.apiKey;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      signal: signal ?? AbortSignal.timeout(15_000),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      // Never surface the response body: it can echo the API key back.
      throw new WahaHttpError(response.status);
    }

    return response;
  }
}

function normalizeGroup(value: unknown): WhatsAppGroup[] {
  if (!isRecord(value)) return [];
  const id = firstString(value.id, value.JID, value.jid);
  if (!id) return [];
  const name = firstString(value.subject, value.Name, value.name) || "Без названия";
  const participants = value.participants ?? value.Participants;
  const explicitCount = value.size ?? value.ParticipantCount ?? value.participantsCount;
  const participantsCount = typeof explicitCount === "number" && Number.isFinite(explicitCount) && explicitCount > 0
    ? Math.trunc(explicitCount)
    : Array.isArray(participants) ? participants.length : 0;
  const rawActivity = value.lastActivityAt ?? value.lastMessageAt ?? value.timestamp;
  const lastActivityAt = normalizeTimestamp(rawActivity);
  return [{ id, name, participantsCount, ...(lastActivityAt ? { lastActivityAt } : {}) }];
}

function firstString(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === "string" && value.trim() !== "")?.trim() ?? "";
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
  }
  return undefined;
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

class WahaHttpError extends Error {
  constructor(readonly status: number) {
    super(`WAHA request failed with status ${status}`);
  }
}
