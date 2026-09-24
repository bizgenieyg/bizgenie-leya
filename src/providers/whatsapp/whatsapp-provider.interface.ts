/**
 * Provider-agnostic WhatsApp transport.
 *
 * Business logic (workers, services) depends only on this interface, never on
 * WAHA directly. Swapping the transport must not touch anything outside
 * `src/providers/whatsapp/`.
 */
export interface SendMessageInput {
  /** WAHA session name that owns the business line. */
  session: string;
  /** Recipient chat id, e.g. `972500000000@c.us`. */
  chatId: string;
  text: string;
}

export interface SendMessageResult {
  /** Provider message id of the sent message (used later for reply matching). */
  id: string;
}

export class SessionNotFoundError extends Error {}

export interface SessionStatus {
  me?: { id?: string; lid?: string };
  reason?: string;
  status: string;
  connected?: boolean;
}

export interface SessionWebhookConfig {
  url: string;
  events: ["message.any", "session.status"];
  retries?: { policy: 'linear' | 'constant' | 'exponential'; delaySeconds: number; attempts: number };
  customHeaders: { name: string; value: string }[];
}

export interface StartSessionInput {
  name: string;
  config: {
    markOnline: false;
    webhooks: SessionWebhookConfig[];
    metadata: { tenant_id: string };
  };
}

export interface QrImage {
  data: Buffer;
  contentType: string;
}

export interface WhatsAppGroup {
  id: string;
  name: string;
  participantsCount: number;
  lastActivityAt?: string;
}

export interface WhatsAppChatActivity {
  id: string;
  conversationTimestamp?: number;
}

export interface WhatsAppChatMessage {
  id: string;
  /** Unix seconds. */
  timestamp: number;
  fromMe: boolean;
  body: string;
  hasMedia: boolean;
}

export interface WhatsAppProvider {
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
  sendSeen?(input: { session: string; chatId: string; messageIds?: string[] }): Promise<void>;
  startTyping?(input: { session: string; chatId: string }): Promise<void>;
  stopTyping?(input: { session: string; chatId: string }): Promise<void>;
  getSessionStatus(session: string): Promise<SessionStatus>;
  getChatMessages?(session: string, chatId: string, options: { limit: number; timeoutMs: number }): Promise<WhatsAppChatMessage[]>;
  /** GOWS: phone JID behind a `@lid` id (`{ pn: '972…@c.us' }`), or null. */
  getLidPhone?(session: string, lid: string, options: { timeoutMs: number }): Promise<string | null>;
}

/** Administrative lifecycle operations for sessions in the shared WAHA container. */
export interface WhatsAppSessionProvider {
  startSession(input: StartSessionInput): Promise<SessionStatus>;
  restartSession(input: StartSessionInput): Promise<SessionStatus>;
  stopSession(session: string): Promise<void>;
  logoutSession(session: string): Promise<void>;
  deleteSession(session: string): Promise<void>;
  getSessionStatus(session: string): Promise<SessionStatus>;
  getQrImage(session: string): Promise<QrImage>;
  getGroups?(session: string): Promise<WhatsAppGroup[]>;
  getSessionConfig?(session: string): Promise<Record<string, unknown> | null>;
  updateSessionConfig?(session: string, config: Record<string, unknown>): Promise<void>;
  getChats?(session: string, options: { limit: number; offset: number; sortBy: "conversationTimestamp"; sortOrder: "desc" }): Promise<WhatsAppChatActivity[]>;
}
