import { SessionNotFoundError } from "./whatsapp-provider.interface.js";
import type {
  SendMessageInput,
  SendMessageResult,
  SessionStatus,
  StartSessionInput,
  WhatsAppProvider,
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
    if (input.replyTo) {
      body.reply_to = input.replyTo;
    }

    const data = await this.request("POST", "/api/sendText", body);
    return { id: extractMessageId(data) };
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
      result.reason = "WAHA не удалось получить состояние подключения.";
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
      ...(signal ? { signal } : {}),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      // Never surface the response body: it can echo the API key back.
      throw new WahaHttpError(response.status);
    }

    return response;
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

class WahaHttpError extends Error {
  constructor(readonly status: number) {
    super(`WAHA request failed with status ${status}`);
  }
}
