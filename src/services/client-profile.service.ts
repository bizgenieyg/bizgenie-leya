import type { DatabaseClient } from '../db/supabase.js';
import { CLIENT_PROFILE_MAX_CHARS } from '../config/discovery.js';
import { intlTimeZone } from '../config/time-zones.js';
import { clientText } from '../utils/assistant-text.js';

const LINE = /^- (\d{2}\.\d{2}): (.+)$/;
const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Merge the model's current fact list into the dated markdown profile: facts already present keep
 * their date, new or changed facts get today's date, facts the model dropped (replaced) disappear.
 * Over the limit the oldest lines go first. Returns null when nothing changed.
 */
export function mergeClientProfile(existing: string, facts: string[], now: Date, timeZone: string): string | null {
  const clean = [...new Map(facts.map(f => clientText(f).replace(/\s+/g, ' ').slice(0, 300)).filter(Boolean).map(f => [normalize(f), f])).values()];
  if (!clean.length) return null;
  const dated = new Map<string, string>();
  for (const line of existing.split('\n')) { const m = LINE.exec(line.trim()); if (m) dated.set(normalize(m[2]!), m[1]!); }
  const today = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', timeZone: intlTimeZone(timeZone) }).format(now);
  const lines = clean.map(fact => `- ${dated.get(normalize(fact)) ?? today}: ${fact}`);
  while (lines.length > 1 && lines.join('\n').length > CLIENT_PROFILE_MAX_CHARS) lines.shift();
  const next = lines.join('\n').slice(0, CLIENT_PROFILE_MAX_CHARS);
  return next === existing.trim() ? null : next;
}

/** Fact texts of a dated profile (dates stripped), to extend it with new facts. */
export function profileFacts(profile: string): string[] {
  return profile.split('\n').map(line => LINE.exec(line.trim())?.[2] ?? '').filter(Boolean);
}

export async function loadClientProfile(db: DatabaseClient, tenantId: string, clientId: string): Promise<string> {
  const row = await db.from('client_profiles').select('profile_md').eq('tenant_id', tenantId).eq('client_id', clientId).maybeSingle();
  if (row.error) throw new Error('Client profile unavailable');
  return typeof row.data?.profile_md === 'string' ? row.data.profile_md : '';
}

/** Leya's own record about the client; the owner's notes (clients.notes) are never touched. */
export async function saveClientProfile(db: DatabaseClient, tenantId: string, clientId: string, profile: string): Promise<void> {
  const now = new Date().toISOString();
  const updated = await db.from('client_profiles').update({ profile_md: profile, last_updated_at: now }).eq('tenant_id', tenantId).eq('client_id', clientId).select('id');
  if (updated.error) throw new Error('Client profile save failed');
  if (updated.data?.length) return;
  const inserted = await db.from('client_profiles').insert({ tenant_id: tenantId, client_id: clientId, profile_md: profile, last_updated_at: now });
  if (inserted.error?.code === '23505') {
    const retry = await db.from('client_profiles').update({ profile_md: profile, last_updated_at: now }).eq('tenant_id', tenantId).eq('client_id', clientId);
    if (retry.error) throw new Error('Client profile save failed');
  } else if (inserted.error) throw new Error('Client profile save failed');
}
