import type { DatabaseClient } from '../db/supabase.js';

export async function purgeExpiredSimulatorMessages(db: DatabaseClient, tenantId: string, retentionHours: number, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionHours * 3600000).toISOString();
  const deleted = await db.from('simulator_messages').delete().eq('tenant_id', tenantId).lt('created_at', cutoff).select('id');
  if (deleted.error) { console.error('simulator_retention_sweep_failed', { tenantId }); return 0; }
  const sessions = await db.from('simulator_sessions').delete().eq('tenant_id', tenantId).lt('updated_at', cutoff).select('id');
  if (sessions.error) console.error('simulator_session_retention_sweep_failed', { tenantId });
  return deleted.data?.length ?? 0;
}
