import { env } from '../config/env.js';
import { supabase, type DatabaseClient } from '../db/supabase.js';
import { sendPlatformAlert } from '../services/platform-alerts.service.js';
import { updateSessionStatus } from '../services/session-status.service.js';

type Session = { name: string; status: string };

export class WahaMonitor {
  private failures = 0;
  private unavailable = false;
  private lastSignature = '';
  constructor(private readonly db: DatabaseClient = supabase,
    private readonly fetchSessions: () => Promise<Session[]> = async () => {
      if (!env.wahaUrl) throw new Error('WAHA_URL missing');
      const response = await fetch(`${env.wahaUrl.replace(/\/+$/, '')}/api/sessions`, {
        headers: env.wahaApiKey ? { 'X-Api-Key': env.wahaApiKey } : {}, signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('WAHA sessions request failed');
      const data: unknown = await response.json();
      if (!Array.isArray(data)) throw new Error('WAHA sessions response invalid');
      return data.flatMap((row): Session[] => row && typeof row === 'object' && typeof row.name === 'string'
        ? [{ name: row.name, status: typeof row.status === 'string' ? row.status : 'UNKNOWN' }] : []);
    }) {}

  async check(): Promise<void> {
    let sessions: Session[];
    try { sessions = await this.fetchSessions(); }
    catch {
      this.failures++;
      if (this.failures >= 2 && !this.unavailable) {
        this.unavailable = true;
        await sendPlatformAlert('waha_down', 'WAHA недоступен');
      }
      return;
    }
    this.failures = 0;
    if (this.unavailable) {
      this.unavailable = false;
      await sendPlatformAlert('waha_recovered', 'WAHA восстановлено');
    }
    // Normal 5-minute probes only contact WAHA. Reconcile tenants on startup or
    // when the WAHA session list/status actually changes.
    const signature = JSON.stringify(sessions.map(session => [session.name, session.status]).sort((a,b) => String(a[0]).localeCompare(String(b[0]))));
    if (signature === this.lastSignature) return;
    const instances = await this.db.from('whatsapp_instances').select('tenant_id,session_name,status');
    if (instances.error) { console.error('waha_monitor_instances_failed'); return; }
    this.lastSignature = signature;
    const byName = new Map(sessions.map(session => [session.name, session.status]));
    for (const instance of instances.data ?? []) {
      const current = String(instance.status ?? '').toUpperCase();
      const observed = byName.get(String(instance.session_name)) ?? 'NOT_CREATED';
      if (current === observed) continue;
      try { await updateSessionStatus(this.db, String(instance.tenant_id), observed); }
      catch { console.error('waha_monitor_status_failed', { tenantId: instance.tenant_id }); }
    }
  }
}

export function startWahaMonitor(): void {
  const monitor = new WahaMonitor();
  const timer = setInterval(() => { void monitor.check(); }, 5 * 60_000);
  timer.unref();
  void monitor.check();
}
