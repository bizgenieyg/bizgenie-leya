import type {
  SessionStatus,
  StartSessionInput,
  WhatsAppSessionProvider,
} from "../providers/whatsapp/whatsapp-provider.interface.js";

export function sessionNameForTenant(tenantId: string): string {
  return `tenant-${tenantId}`;
}

/** Target webhook subscription: message.any carries the owner's own sends (takeover) and all inbound. */
export const WEBHOOK_EVENTS = ["message.any", "session.status"] as const;
export const WEBHOOK_SYNC_PAUSE_MS = 2_500;
export const WEBHOOK_SYNC_WAIT_MS = 60_000;
export const WEBHOOK_SYNC_POLL_MS = 3_000;

export function sessionConfigForTenant(
  tenantId: string,
  publicBaseUrl: string,
  webhookSecret: string,
): StartSessionInput {
  const baseUrl = publicBaseUrl.replace(/\/+$/, "");
  return {
    name: sessionNameForTenant(tenantId),
    config: {
      markOnline: false,
      webhooks: [
        {
          url: `${baseUrl}/webhook/${tenantId}`,
          events: [...WEBHOOK_EVENTS],
          retries: { policy: 'linear', delaySeconds: 2, attempts: 4 },
          customHeaders: [{ name: "X-Webhook-Token", value: webhookSecret }],
        },
      ],
      metadata: { tenant_id: tenantId },
    },
  };
}

export async function reconnectWahaSession(
  provider: WhatsAppSessionProvider,
  config: StartSessionInput,
): Promise<SessionStatus> {
  const status = await provider.restartSession(config);
  if (status.status !== "FAILED" && status.status !== "STOPPED") return status;
  // WAHA recommends logout when restart cannot recover FAILED.
  await provider.logoutSession(config.name);
  await provider.stopSession(config.name);
  await provider.deleteSession(config.name);
  return provider.startSession(config);
}

export async function disconnectWahaSession(
  provider: WhatsAppSessionProvider,
  session: string,
): Promise<void> {
  await provider.logoutSession(session);
  await provider.stopSession(session);
  await provider.deleteSession(session);
}
