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
): StartSessionInput {
  const baseUrl = publicBaseUrl.replace(/\/+$/, "");
  return {
    name: sessionNameForTenant(tenantId),
    config: {
      webhooks: [
        {
          url: `${baseUrl}/webhook/${tenantId}`,
          events: ["message", "session.status"],
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
  await provider.stopSession(config.name);
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
