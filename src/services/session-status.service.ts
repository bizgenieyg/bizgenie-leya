import type { DatabaseClient } from '../db/supabase.js';
import { sendPlatformAlert, safeAlertLabel } from './platform-alerts.service.js';
import { invalidateTenantRouting } from './tenant.service.js';

export const SESSION_FAILURES = new Set(['FAILED', 'STOPPED', 'SCAN_QR_CODE', 'NOT_CREATED']);

export async function updateSessionStatus(db: DatabaseClient, tenantId: string, status: string,
  alert: typeof sendPlatformAlert = sendPlatformAlert): Promise<void> {
  const normalized = status.toUpperCase();
  const current = await db.from('whatsapp_instances').select('status').eq('tenant_id', tenantId).maybeSingle();
  if (current.error || !current.data) throw new Error('WhatsApp instance lookup failed');
  const previous = String(current.data.status ?? '').toUpperCase();
  if (previous === normalized) return;
  const updated = await db.from('whatsapp_instances').update({ status: normalized, status_changed_at: new Date().toISOString() })
    .eq('tenant_id', tenantId).eq('status', current.data.status).select('id').maybeSingle();
  if (updated.error) throw new Error('WhatsApp instance update failed');
  if (!updated.data) return;
  invalidateTenantRouting(db, tenantId);
  if (previous !== 'WORKING' && normalized !== 'WORKING') return;
  const tenant = await db.from('tenants').select('business_name,name').eq('id', tenantId).maybeSingle();
  const business = safeAlertLabel(tenant.data?.business_name ?? tenant.data?.name ?? tenantId);
  if (previous === 'WORKING' && SESSION_FAILURES.has(normalized))
    await alert('session_down', `WhatsApp отключён: ${business} (${tenantId}), статус ${normalized}`, tenantId);
  if (normalized === 'WORKING' && SESSION_FAILURES.has(previous))
    await alert('session_recovered', `WhatsApp восстановлено: ${business} (${tenantId})`, tenantId);
}

export function sessionStatusFromWebhook(body: Record<string, unknown>): string | null {
  if (body.event !== 'session.status') return null;
  const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload as Record<string, unknown> : {};
  const status = typeof payload.status === 'string' ? payload.status : typeof body.status === 'string' ? body.status : '';
  return /^[A-Z_]+$/.test(status.toUpperCase()) && status ? status.toUpperCase() : null;
}
