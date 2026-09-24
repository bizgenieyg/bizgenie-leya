import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { phoneFromJid } from '../utils/whatsapp-id.js';

const CACHE_TTL_MS = 24 * 60 * 60_000;
const cache = new Map<string, { phone: string | null; expiresAt: number }>();
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * The real number behind an incoming chat: the JID itself for `@c.us`, `_data.Info.SenderAlt`
 * for `@lid`, then WAHA GOWS `/lids/{lid}` (cached). Unknown stays null — a lid is never a phone.
 */
export async function resolveClientPhone(provider: WhatsAppProvider, session: string, from: string,
  body: Record<string, unknown> | null, timeoutSeconds: number): Promise<string | null> {
  const direct = phoneFromJid(from);
  if (direct) return direct;
  if (!from.endsWith('@lid')) return null;
  const info = record(record(record(body?.payload)._data).Info);
  const alt = phoneFromJid(info.SenderAlt);
  if (alt) return alt;
  const cached = cache.get(`${session}:${from}`);
  if (cached && cached.expiresAt > Date.now()) return cached.phone;
  if (!provider.getLidPhone) return null;
  let phone: string | null = null;
  try { phone = phoneFromJid(await provider.getLidPhone(session, from, { timeoutMs: timeoutSeconds * 1000 })); }
  catch { console.warn('client_lid_lookup_failed'); return null; }
  cache.set(`${session}:${from}`, { phone, expiresAt: Date.now() + CACHE_TTL_MS });
  return phone;
}

export function clearClientPhoneCache(): void { cache.clear(); }

/**
 * One-off backfill: real numbers for existing `@lid` clients, with a pause between WAHA calls.
 * A number already used by another client is left unresolved rather than merging cards.
 */
export async function resolveTenantClientPhones(db: import('../db/supabase.js').DatabaseClient, provider: WhatsAppProvider, tenantId: string,
  options: { pauseMs: number; timeoutSeconds: number }): Promise<{ checked: number; resolved: number; unresolved: number }> {
  const instance = await db.from('whatsapp_instances').select('session_name').eq('tenant_id', tenantId).maybeSingle();
  if (instance.error) throw new Error('WhatsApp instance lookup failed');
  const session = typeof instance.data?.session_name === 'string' ? instance.data.session_name : null;
  const clients = await db.from('clients').select('id,whatsapp_jid').eq('tenant_id', tenantId).is('phone', null).like('whatsapp_jid', '%@lid');
  if (clients.error) throw new Error('Client lookup failed');
  let resolved = 0, unresolved = 0;
  for (const [index, client] of (clients.data ?? []).entries()) {
    if (index && options.pauseMs) await new Promise(resolve => setTimeout(resolve, options.pauseMs));
    const phone = session ? await resolveClientPhone(provider, session, String(client.whatsapp_jid), null, options.timeoutSeconds) : null;
    if (!phone) { unresolved++; continue; }
    const updated = await db.from('clients').update({ phone }).eq('tenant_id', tenantId).eq('id', client.id).is('phone', null);
    if (updated.error) { unresolved++; continue; }
    resolved++;
  }
  return { checked: clients.data?.length ?? 0, resolved, unresolved };
}
