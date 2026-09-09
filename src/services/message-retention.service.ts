import type { DatabaseClient } from '../db/supabase.js';
import { MESSAGE_RETENTION_MIN_DAYS } from '../config/behavior.js';

/**
 * Delete stored `messages` rows past the tenant's retention window. This is the only
 * place messages are removed; the conversation context loader (context.service.ts) is
 * read-only. Runs on the scheduler, off the incoming-message hot path.
 *
 * `retentionDays` comes from behavior.message_retention_days and is floored at
 * MESSAGE_RETENTION_MIN_DAYS so a misconfigured tenant cannot shrink history to nothing.
 */
export async function purgeExpiredMessages(db:DatabaseClient,tenantId:string,retentionDays:number,now=new Date()):Promise<number>{
  const days=Number.isFinite(retentionDays)?Math.max(MESSAGE_RETENTION_MIN_DAYS,Math.floor(retentionDays)):MESSAGE_RETENTION_MIN_DAYS;
  const cutoff=new Date(now.getTime()-days*86400000).toISOString();
  const {data,error}=await db.from('messages').delete().eq('tenant_id',tenantId).lt('created_at',cutoff).select('id');
  if(error){console.error('message_retention_sweep_failed',{tenantId});return 0;}
  return data?.length??0;
}
