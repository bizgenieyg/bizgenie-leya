import type {
  SessionStatus,
  StartSessionInput,
  WhatsAppSessionProvider,
} from "../providers/whatsapp/whatsapp-provider.interface.js";

export function sessionNameForTenant(tenantId: string): string {
  return `tenant-${tenantId}`;
}

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
          events: ["message", "session.status"],
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
