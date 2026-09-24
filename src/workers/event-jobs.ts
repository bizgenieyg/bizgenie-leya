import { MESSAGE_RETENTION_SWEEP_MS } from '../config/behavior.js';
import type { DatabaseClient } from '../db/supabase.js';
import { createWhatsAppProvider } from '../providers/whatsapp/index.js';
import { nextQuietHoursEnd, isWithinQuietHours } from '../services/escalation.service.js';
import { nextEscalationDeadline } from '../services/escalation-deadline.js';
import { purgeExpiredMessages } from '../services/message-retention.service.js';
import { purgeExpiredSimulatorMessages } from '../services/simulator-retention.service.js';
import { loadOwnerSettings } from '../services/owner-settings.service.js';
import { behavior } from '../services/runtime-settings.service.js';
import { deliverOwnerSummaryIfDue, ensureOwnerSummaryJob } from '../services/owner-summary.service.js';
import { runDueScheduledEscalations, runEscalationTimeouts, scheduleEscalationTimeout, type Escalation } from '../services/owner-workflow.service.js';
import { scheduleWake } from './job-wake.js';
import type { ScheduledJob } from './job-timer.js';

const check = (error: unknown) => { if (error) throw new Error('Scheduled job persistence failed'); };

export async function ensureRetentionSweep(db: DatabaseClient, now = new Date()): Promise<void> {
  const active = await db.from('scheduled_jobs').select('scheduled_at').eq('job_type', 'retention_sweep')
    .in('status', ['pending', 'sending']).limit(1);check(active.error);
  if (active.data?.length) { scheduleWake(new Date(String(active.data[0]!.scheduled_at))); return; }
  const inserted = await db.from('scheduled_jobs').insert({ tenant_id: null, job_type: 'retention_sweep',
    payload: {}, scheduled_at: now.toISOString(), status: 'pending' });
  if (inserted.error?.code !== '23505') check(inserted.error);
  scheduleWake(now);
}

export async function seedDurableJobs(db: DatabaseClient, now = new Date()): Promise<void> {
  await ensureRetentionSweep(db, now);
  const instances = await db.from('whatsapp_instances').select('tenant_id,session_name');check(instances.error);
  const settingsByTenant = new Map<string, Awaited<ReturnType<typeof loadOwnerSettings>>>();
  for (const row of instances.data ?? []) {
    const settings = await loadOwnerSettings(db, row.tenant_id);
    settingsByTenant.set(row.tenant_id, settings);
    await ensureOwnerSummaryJob(db, row.tenant_id, settings, now);
  }
  const pending = await db.from('escalations').select('*').eq('status', 'pending');check(pending.error);
  for (const row of pending.data ?? []) {
    const escalation = row as Escalation;
    let settings = settingsByTenant.get(escalation.tenant_id);
    if (!settings) { settings = await loadOwnerSettings(db, escalation.tenant_id); settingsByTenant.set(escalation.tenant_id, settings); }
    await scheduleEscalationTimeout(db, escalation, settings, now);
  }
}

async function runRetentionSweep(db: DatabaseClient, job: ScheduledJob, now: Date): Promise<void> {
  const oldInbound = await db.from('inbound_events').delete().in('status', ['done', 'ignored', 'failed'])
    .lt('processed_at', new Date(now.getTime() - 7 * 24 * 60 * 60_000).toISOString());
  if (oldInbound.error) console.error('inbound_retention_sweep_failed');
  const instances = await db.from('whatsapp_instances').select('tenant_id');check(instances.error);
  for (const row of instances.data ?? []) {
    let settings: Awaited<ReturnType<typeof loadOwnerSettings>>;
    try { settings = await loadOwnerSettings(db, row.tenant_id); }
    catch { console.error('retention_settings_load_failed', { tenantId: row.tenant_id }); continue; }
    try {
      await purgeExpiredMessages(db, row.tenant_id, behavior(settings).message_retention_days, now);
    } catch { console.error('message_retention_sweep_failed', { tenantId: row.tenant_id }); }
    try {
      await purgeExpiredSimulatorMessages(db, row.tenant_id, behavior(settings).context_retention_hours, now);
    } catch { console.error('simulator_retention_sweep_failed', { tenantId: row.tenant_id }); }
  }
  const next = new Date(now.getTime() + MESSAGE_RETENTION_SWEEP_MS);
  const updated = await db.from('scheduled_jobs').update({ status: 'pending', scheduled_at: next.toISOString(), executed_at: now.toISOString(), error: null })
    .eq('id', job.id).eq('status', 'sending');check(updated.error);
  scheduleWake(next);
}

async function runTimeout(db: DatabaseClient, job: ScheduledJob, now: Date): Promise<void> {
  const tenantId = job.tenant_id, escalationId = job.payload.escalation_id;
  if (!tenantId || typeof escalationId !== 'string') return;
  await runEscalationTimeouts(db, createWhatsAppProvider, now, tenantId, escalationId);
  const found = await db.from('escalations').select('*').eq('tenant_id', tenantId).eq('id', escalationId).maybeSingle();check(found.error);
  const escalation = found.data as Escalation | null;
  if (!escalation || escalation.status !== 'pending') return;
  const settings = await loadOwnerSettings(db, tenantId);
  const expiry = new Date(new Date(escalation.created_at ?? now).getTime() + Number(behavior(settings).deferred_max_age_hours) * 3_600_000 + 1);
  let notBefore: Date | undefined;
  if (isWithinQuietHours(settings, now)) notBefore = nextQuietHoursEnd(settings, now) ?? expiry;
  else if (settings.auto_replies_paused) notBefore = expiry;
  else {
    const conversation = await db.from('conversations').select('bot_paused,owner_last_activity_at')
      .eq('tenant_id', tenantId).eq('id', escalation.conversation_id).maybeSingle();check(conversation.error);
    if (conversation.data?.bot_paused) {
      const hours = Number(behavior(settings).auto_resume_hours);
      const resumeAt = hours > 0 && conversation.data.owner_last_activity_at
        ? new Date(new Date(conversation.data.owner_last_activity_at).getTime() + hours * 3_600_000) : expiry;
      notBefore = resumeAt < expiry ? resumeAt : expiry;
    }
  }
  const due = nextEscalationDeadline(settings, escalation, now);
  if (!notBefore && due <= now) notBefore = new Date(now.getTime() + 60_000);
  await scheduleEscalationTimeout(db, escalation, settings, now, notBefore);
}

async function runSummary(db: DatabaseClient, job: ScheduledJob, now: Date): Promise<void> {
  if (!job.tenant_id) return;
  const instance = await db.from('whatsapp_instances').select('session_name').eq('tenant_id', job.tenant_id).maybeSingle();check(instance.error);
  if (!instance.data?.session_name) {
    const cancelled = await db.from('scheduled_jobs').update({ status: 'cancelled', executed_at: now.toISOString() }).eq('id', job.id);check(cancelled.error);
    return;
  }
  await deliverOwnerSummaryIfDue(db, job.tenant_id, instance.data.session_name, createWhatsAppProvider(), now);
  const current = await db.from('scheduled_jobs').select('status,scheduled_at').eq('id', job.id).maybeSingle();check(current.error);
  if (!current.data) return;
  if (current.data.status === 'pending' && new Date(current.data.scheduled_at) <= now) {
    const settings = await loadOwnerSettings(db, job.tenant_id);
    const next = isWithinQuietHours(settings, now) ? nextQuietHoursEnd(settings, now) : null;
    const retry = next ?? new Date(now.getTime() + 60 * 60_000);
    const deferred = await db.from('scheduled_jobs').update({ scheduled_at: retry.toISOString() }).eq('id', job.id).eq('status', 'pending');check(deferred.error);
    scheduleWake(retry);
  }
}

export async function runEventJob(db: DatabaseClient, job: ScheduledJob): Promise<void> {
  const now = new Date();
  if (job.job_type === 'retention_sweep') return runRetentionSweep(db, job, now);
  if (job.job_type === 'owner_escalation') {
    await runDueScheduledEscalations(db, createWhatsAppProvider, now, job.tenant_id ?? undefined, job.id);
    return;
  }
  if (job.job_type === 'escalation_timeout') return runTimeout(db, job, now);
  if (job.job_type === 'owner_summary') return runSummary(db, job, now);
}
