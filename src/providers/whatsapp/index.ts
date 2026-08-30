import { env, requireEnv } from "../../config/env.js";
import { WahaProvider } from "./waha.provider.js";
import type { WhatsAppProvider, WhatsAppSessionProvider } from "./whatsapp-provider.interface.js";

export type { WhatsAppProvider, WhatsAppSessionProvider } from "./whatsapp-provider.interface.js";

/**
 * Build the WhatsApp provider for outbound sends.
 *
 * Both the shared-container URL and API key come from backend environment only.
 */
export function createWhatsAppProvider(): WhatsAppProvider {
  return new WahaProvider(requireEnv("WAHA_URL"), env.wahaApiKey);
}

export function createWhatsAppSessionProvider(): WhatsAppSessionProvider {
  return new WahaProvider(requireEnv("WAHA_URL"), env.wahaApiKey);
}
