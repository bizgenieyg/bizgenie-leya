import { supabase, type DatabaseClient } from '../db/supabase.js';
import { env } from '../config/env.js';

export async function deepHealth(db: DatabaseClient = supabase) {
  const result: Record<string, unknown> = { status: 'ok' };
  try {
    const query = await db.from('tenants').select('id', { count: 'exact', head: true }).limit(1);
    if (query.error) throw query.error;
    result.database = 'ok';
  } catch { result.database = 'unavailable'; result.status = 'degraded'; }
  try {
    if (!env.wahaUrl) throw new Error('WAHA_URL missing');
    const response = await fetch(`${env.wahaUrl.replace(/\/+$/, '')}/api/sessions`, {
      headers: env.wahaApiKey ? { 'X-Api-Key': env.wahaApiKey } : {}, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('WAHA unavailable');
    result.waha = 'ok';
  } catch { result.waha = 'unavailable'; result.status = 'degraded'; }
  for (const [label, table] of [['inbound', 'inbound_events'], ['outbound', 'outbound_messages']] as const) {
    const timestamp = label === 'inbound' ? 'received_at' : 'created_at';
    const pending = await db.from(table).select(timestamp, { count: 'exact' }).eq('status', 'pending')
      .order(timestamp, { ascending: true }).limit(1);
    if (pending.error?.code === '42P01' || pending.error?.code === 'PGRST205') continue;
    if (pending.error) { result.status = 'degraded'; result[label] = 'unavailable'; continue; }
    result[label] = { pending: pending.count ?? 0, oldestPendingAt: (pending.data?.[0] as Record<string, unknown> | undefined)?.[timestamp] ?? null };
  }
  return result;
}
