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
  /** WhatsApp message id to quote, when replying in-thread. */
  replyTo?: string;
}

export interface SendMessageResult {
  /** Provider message id of the sent message (used later for reply matching). */
  id: string;
}

export interface SessionStatus {
  status: string;
  connected?: boolean;
}

export interface SessionWebhookConfig {
  url: string;
  events: ["message", "session.status"];
}

export interface StartSessionInput {
  name: string;
  config: {
    webhooks: SessionWebhookConfig[];
    metadata: { tenant_id: string };
  };
}

export interface QrImage {
  data: Buffer;
  contentType: string;
}

export interface WhatsAppProvider {
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
  getSessionStatus(session: string): Promise<SessionStatus>;
}

/** Administrative lifecycle operations for sessions in the shared WAHA container. */
export interface WhatsAppSessionProvider {
  startSession(input: StartSessionInput): Promise<SessionStatus>;
  stopSession(session: string): Promise<void>;
  logoutSession(session: string): Promise<void>;
  deleteSession(session: string): Promise<void>;
  getSessionStatus(session: string): Promise<SessionStatus>;
  getQrImage(session: string): Promise<QrImage>;
}
