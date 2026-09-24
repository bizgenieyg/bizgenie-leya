import type { DatabaseClient } from '../db/supabase.js';
import { sendPlatformAlert, safeAlertLabel } from './platform-alerts.service.js';
import { invalidateTenantRouting } from './tenant.service.js';

export const SESSION_FAILURES = new Set(['FAILED', 'STOPPED', 'SCAN_QR_CODE', 'NOT_CREATED']);

/**
 * Alert state lives in whatsapp_instances.last_session_alert, not in process memory:
 * - any transition into a failure status alerts once, if the last alert was not already "down";
 * - WORKING after a "down" alert sends "recovered". Intermediate statuses (STARTING…) never reset it.
 * Evaluated even when the status is unchanged, so a restart between status write and alert catches up.
 */
export async function updateSessionStatus(db: DatabaseClient, tenantId: string, status: string,
  alert: typeof sendPlatformAlert = sendPlatformAlert): Promise<void> {
  const normalized = status.toUpperCase();
  const current = await db.from('whatsapp_instances').select('status').eq('tenant_id', tenantId).maybeSingle();
  if (current.error || !current.data) throw new Error('WhatsApp instance lookup failed');
  const previous = String(current.data.status ?? '').toUpperCase();
  if (previous !== normalized) {
    const updated = await db.from('whatsapp_instances').update({ status: normalized, status_changed_at: new Date().toISOString() })
      .eq('tenant_id', tenantId).eq('status', current.data.status).select('id').maybeSingle();
    if (updated.error) throw new Error('WhatsApp instance update failed');
    if (!updated.data) return;
    invalidateTenantRouting(db, tenantId);
  }
  const transition = async (from: 'session_recovered' | 'session_down' | null, to: 'session_down' | 'session_recovered') => {
    const base = db.from('whatsapp_instances').update({ last_session_alert: to }).eq('tenant_id', tenantId).eq('status', normalized);
    const claimed = await (from === null ? base.is('last_session_alert', null) : base.eq('last_session_alert', from)).select('id').maybeSingle();
    if (claimed.error) throw new Error('WhatsApp alert state update failed');
    return !!claimed.data;
  };
  if (SESSION_FAILURES.has(normalized)) {
    if (!await transition('session_recovered', 'session_down')) return;
    await alert('session_down', `WhatsApp отключён: ${await businessLabel(db, tenantId)} (${tenantId}), статус ${normalized}`, tenantId);
  } else if (normalized === 'WORKING') {
    if (await transition(null, 'session_recovered')) return; // first connection: nothing to recover from
    if (!await transition('session_down', 'session_recovered')) return;
    await alert('session_recovered', `WhatsApp восстановлено: ${await businessLabel(db, tenantId)} (${tenantId})`, tenantId);
  }
}

async function businessLabel(db: DatabaseClient, tenantId: string): Promise<string> {
  const tenant = await db.from('tenants').select('business_name,name').eq('id', tenantId).maybeSingle();
  return safeAlertLabel(tenant.data?.business_name ?? tenant.data?.name ?? tenantId);
}

export function sessionStatusFromWebhook(body: Record<string, unknown>): string | null {
  if (body.event !== 'session.status') return null;
  const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload as Record<string, unknown> : {};
  const status = typeof payload.status === 'string' ? payload.status : typeof body.status === 'string' ? body.status : '';
  return /^[A-Z_]+$/.test(status.toUpperCase()) && status ? status.toUpperCase() : null;
}
