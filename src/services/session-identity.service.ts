import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { readSessionIdentity, type SessionIdentity } from '../utils/incoming-policy.js';

const identities = new Map<string, { value: SessionIdentity; expiresAt: number }>();
const TTL_MS = 10 * 60_000;

export function invalidateSessionIdentity(session: string): void { identities.delete(session); }

export async function sessionIdentity(provider: WhatsAppProvider, session: string, useCache = true): Promise<SessionIdentity> {
  const cached = useCache ? identities.get(session) : undefined;
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = readSessionIdentity((await provider.getSessionStatus(session)).me);
  if (useCache) identities.set(session, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}
