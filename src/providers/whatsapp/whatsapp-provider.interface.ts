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

export interface WhatsAppProvider {
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
  getSessionStatus(session: string): Promise<SessionStatus>;
}
