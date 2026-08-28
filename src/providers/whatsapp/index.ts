import { env, requireEnv } from "../../config/env.js";
import { WahaProvider } from "./waha.provider.js";
import type { WhatsAppProvider } from "./whatsapp-provider.interface.js";

export type { WhatsAppProvider } from "./whatsapp-provider.interface.js";

/**
 * Build the WhatsApp provider for outbound sends.
 *
 * `WAHA_URL` is read from the environment only. `apiKey` is the per-tenant WAHA
 * key (decrypted by the caller); when absent it falls back to `WAHA_API_KEY`.
 */
export function createWhatsAppProvider(apiKey?: string): WhatsAppProvider {
  return new WahaProvider(requireEnv("WAHA_URL"), apiKey ?? env.wahaApiKey);
}
