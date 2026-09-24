import { randomUUID } from 'node:crypto';
import type { DatabaseClient } from '../db/supabase.js';
import { supabase } from '../db/supabase.js';
import type { SendMessageInput, WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { createWhatsAppProvider } from '../providers/whatsapp/index.js';
import { behavior } from '../services/runtime-settings.service.js';
import { loadOwnerSettings, ownerDestination } from '../services/owner-settings.service.js';
import { renderText } from '../services/templates.service.js';
import { logSystemEvent } from '../services/logging.service.js';
import { recordUsageEvent } from '../services/usage.service.js';
import { intlTimeZone } from '../config/time-zones.js';
import { allowedRecipient } from '../utils/incoming-policy.js';

export type OutboundKind = 'reply' | 'owner_notice' | 'owner_answer_delivery' | 'summary' | 'reminder' | 'broadcast';
export interface OutboundRow {
  id: string; tenant_id: string; session: string; chat_id: string; text: string; kind: OutboundKind;
  priority: number; not_before: string; deadline_at: string | null; status: string;
  attempts: number; dedupe_key: string; inbound_message_ids: string[]; created_at: string; started_at: string | null;
}
export interface EnqueueOptions {
  kind?: OutboundKind; dedupeKey?: string; notBefore?: Date; deadlineAt?: Date;
  inboundMessageIds?: string[]; waitForDelivery?: boolean;
}
const MAX_CONCURRENT = 5;
const LEASE_MS = 2 * 60_000;
const MAX_DELAY = 2_147_000_000;
const processors = new WeakMap<DatabaseClient, OutboundProcessor>();
const pendingResults = new Map<string, Array<{ resolve: (id: string) => void; reject: (error: Error) => void }>>();
function settle(id: string, result: string | Error): void {
  for (const waiter of pendingResults.get(id) ?? []) {
    if (result instanceof Error) waiter.reject(result); else waiter.resolve(result);
  }
  pendingResults.delete(id);
}

export const outboundPriority = (kind: OutboundKind): number =>
  kind === 'reply' || kind === 'owner_answer_delivery' ? 0 : kind === 'owner_notice' ? 1 : kind === 'broadcast' ? 3 : 2;

export function randomBetween(min: number, max: number, random = Math.random): number {
  return min + (max - min) * random();
}

export function plannedNotBefore(createdAt: Date, sendAt: Date, spreadMinutes: number, random = Math.random): Date {
  const interval = Math.max(0, sendAt.getTime() - createdAt.getTime());
  const spread = Math.min(Math.max(0, spreadMinutes) * 60_000, 20 * 60_000, interval / 2);
  return new Date(sendAt.getTime() - random() * spread);
}

export function typingDelayMs(length: number, config: ReturnType<typeof behavior>, random = Math.random): number {
  const factor = randomBetween(config.outbound_typing_seconds_per_100_min, config.outbound_typing_seconds_per_100_max, random);
  return Math.round(Math.min(config.outbound_typing_max_seconds, Math.max(config.outbound_typing_min_seconds, length / 100 * factor)) * 1000);
}

export function gapMs(kind: OutboundKind, config: ReturnType<typeof behavior>, random = Math.random): number {
  const proactive = kind === 'summary' || kind === 'reminder' || kind === 'broadcast';
  return Math.round(1000 * (proactive
    ? randomBetween(config.outbound_proactive_gap_min_seconds, config.outbound_proactive_gap_max_seconds, random)
    : randomBetween(config.outbound_conversation_gap_min_seconds, config.outbound_conversation_gap_max_seconds, random)));
}

function delay(ms: number): Promise<void> { return new Promise(resolve => { setTimeout(resolve, ms); }); }

export async function enqueueMessage(db: DatabaseClient, tenantId: string, provider: WhatsAppProvider,
  input: SendMessageInput, options: EnqueueOptions = {}): Promise<{ id: string }> {
  if (!allowedRecipient(input.chatId) || !input.text.trim()) throw new Error('Outbound recipient or text invalid');
  const kind = options.kind ?? 'reply';
  const dedupeKey = options.dedupeKey ?? randomUUID();
  const payload = { tenant_id: tenantId, session: input.session, chat_id: input.chatId, text: input.text,
    kind, priority: outboundPriority(kind), dedupe_key: dedupeKey,
    not_before: (options.notBefore ?? new Date()).toISOString(), deadline_at: options.deadlineAt?.toISOString() ?? null,
    inbound_message_ids: options.inboundMessageIds ?? [] };
  let result = await db.from('outbound_messages').insert(payload).select('id,status,waha_msg_id').single();
  if (result.error?.code === '23505') result = await db.from('outbound_messages').select('id,status,waha_msg_id')
    .eq('tenant_id', tenantId).eq('dedupe_key', dedupeKey).single();
  if (result.error || !result.data) throw new Error('Outbound enqueue failed');
  const row = result.data as { id: string; status: string; waha_msg_id: string | null };
  if (row.status === 'sent') return { id: row.waha_msg_id ?? '' };
  if (['failed', 'cancelled', 'expired'].includes(row.status)) throw new Error('Outbound message unavailable');
  let processor = processors.get(db);
  if (!processor) {
    processor = new OutboundProcessor(db, provider);
    processors.set(db, processor);
  }
  processor.launch();
  if (options.waitForDelivery === false) { processor.wake(new Date(payload.not_before)); return { id: row.id }; }
  const waiting = new Promise<{ id: string }>((resolve, reject) => {
    const waiters = pendingResults.get(row.id) ?? [];
    waiters.push({ resolve: id => resolve({ id }), reject });
    pendingResults.set(row.id, waiters);
  });
  processor.wake(new Date(payload.not_before));
  return waiting;
}

/** Scheduled client reminders may move earlier but never past the event they describe. */
export async function enqueuePlannedReminder(db: DatabaseClient, tenantId: string, provider: WhatsAppProvider,
  input: SendMessageInput, schedule: { sendAt: Date; eventAt: Date; dedupeKey: string }): Promise<{ id: string }> {
  const settings = await loadOwnerSettings(db, tenantId);
  const notBefore = plannedNotBefore(new Date(), schedule.sendAt, behavior(settings).outbound_reminder_spread_minutes);
  return enqueueMessage(db, tenantId, provider, input, { kind: 'reminder', dedupeKey: schedule.dedupeKey,
    notBefore, deadlineAt: schedule.eventAt, waitForDelivery: false });
}

export async function cancelPendingReplies(db: DatabaseClient, tenantId: string, chatId: string): Promise<void> {
  const cancelled = await db.from('outbound_messages').update({ status: 'cancelled' })
    .eq('tenant_id', tenantId).eq('chat_id', chatId).eq('kind', 'reply').eq('status', 'pending').select('id');
  if (cancelled.error) throw new Error('Outbound cancellation failed');
  for (const row of cancelled.data ?? []) {
    settle(String(row.id), new Error('Outbound reply cancelled by owner'));
  }
}

export class OutboundProcessor {
  private timer: NodeJS.Timeout | null = null;
  private timerAt = Number.POSITIVE_INFINITY;
  private scanning = false;
  private scanAgain = false;
  private wakeVersion = 0;
  private stopped = false;
  private active = 0;
  private readonly sessions = new Set<string>();
  private readonly cooldowns = new Map<string, number>();
  private readonly lastGaps = new Map<string, number>();
  private readonly tasks = new Set<Promise<void>>();
  private startup: Promise<void> | null = null;
  private started = false;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(private readonly db: DatabaseClient, private readonly provider: WhatsAppProvider) {}

  launch(): void {
    if (this.startup || this.started || this.stopped) return;
    this.startup = this.start().catch(() => {
      if (!this.stopped) {
        console.error('outbound_queue_start_failed');
        this.retryTimer = setTimeout(() => { this.retryTimer = null; this.launch(); }, 30_000);
        this.retryTimer.unref();
      }
    })
      .finally(() => { this.startup = null; });
  }

  async start(): Promise<void> {
    await this.recoverStale();
    await this.refresh();
    this.started = true;
  }

  private async recoverStale(): Promise<void> {
    const stale = await this.db.from('outbound_messages').update({ status: 'pending', started_at: null })
      .eq('status', 'sending').lte('started_at', new Date(Date.now() - LEASE_MS).toISOString());
    if (stale.error) throw new Error('Outbound recovery failed');
  }

  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); if (this.retryTimer) clearTimeout(this.retryTimer); }
  async drain(): Promise<void> { if (this.startup) await this.startup; while (this.scanning || this.tasks.size) { await Promise.allSettled([...this.tasks]); if (this.scanning) await delay(10); } }
  wake(at: Date): void {
    this.wakeVersion++;
    if (this.stopped) return;
    if (this.scanning && at.getTime() <= Date.now()) this.scanAgain = true;
    if (at.getTime() < this.timerAt) this.arm(at.getTime());
    else if (pendingResults.size) this.timer?.ref();
  }
  private arm(at: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => { this.timer = null; if (at > Date.now()) this.arm(at); else void this.fire(); },
      Math.min(Math.max(0, at - Date.now()), MAX_DELAY));
    if (!pendingResults.size) this.timer.unref();
  }
  private async refresh(): Promise<void> {
    if (this.stopped) return;
    const version = this.wakeVersion;
    const next = await this.db.from('outbound_messages').select('session,not_before').eq('status', 'pending')
      .order('not_before', { ascending: true }).limit(200);
    if (next.error) throw new Error('Outbound next-event lookup failed');
    const processing = await this.db.from('outbound_messages').select('started_at').eq('status','sending')
      .order('started_at',{ascending:true}).limit(1);
    if (processing.error) throw new Error('Outbound lease lookup failed');
    const pending = (next.data ?? []).filter(row => !this.sessions.has(String(row.session)));
    const pendingAt = pending.reduce((earliest, row) => Math.min(earliest,
      Math.max(new Date(String(row.not_before)).getTime(), this.cooldowns.get(String(row.session)) ?? 0)), Number.POSITIVE_INFINITY);
    const leaseAt = processing.data?.length ? new Date(String(processing.data[0]!.started_at)).getTime() + LEASE_MS : Number.POSITIVE_INFINITY;
    const target = Math.min(pendingAt, leaseAt);
    if (this.stopped || (version !== this.wakeVersion && this.timerAt < target)) return;
    if (!Number.isFinite(target)) { if (this.timer) clearTimeout(this.timer); this.timer = null; this.timerAt = Number.POSITIVE_INFINITY; }
    else this.arm(target);
  }
  private async fire(): Promise<void> {
    if (this.stopped) return;
    if (this.scanning || this.active >= MAX_CONCURRENT) { this.scanAgain = true; return; }
    this.scanning = true;
    try {
      await this.recoverStale();
      const due = await this.db.from('outbound_messages').select('*').eq('status', 'pending')
        .lte('not_before', new Date().toISOString()).order('priority', { ascending: true })
        .limit(200);
      if (due.error) throw new Error('Outbound due-event lookup failed');
      const ordered = [...(due.data ?? [])].sort((a,b) => Number(a.priority)-Number(b.priority) ||
        Date.parse(String(a.not_before))-Date.parse(String(b.not_before)) ||
        Date.parse(String(a.created_at))-Date.parse(String(b.created_at)));
      for (const raw of ordered) {
        if (this.active >= MAX_CONCURRENT) break;
        const row = raw as OutboundRow;
        if (this.sessions.has(row.session) || (this.cooldowns.get(row.session) ?? 0) > Date.now()) continue;
        this.sessions.add(row.session); this.active++;
        const task = this.processRow(row).catch(() => { console.error('outbound_claim_failed'); if (!this.stopped) this.arm(Date.now() + 30_000); })
          .finally(() => { this.sessions.delete(row.session); this.active--; this.tasks.delete(task); void this.fire(); });
        this.tasks.add(task);
      }
      await this.refresh();
    } catch { console.error('outbound_queue_wake_failed'); this.arm(Date.now() + 30_000); }
    finally { this.scanning = false; if (this.scanAgain && this.active < MAX_CONCURRENT) { this.scanAgain = false; queueMicrotask(() => { void this.fire(); }); } }
  }
  private async processRow(row: OutboundRow): Promise<void> {
    const claimed = await this.db.from('outbound_messages').update({ status: 'sending', started_at: new Date().toISOString() })
      .eq('id', row.id).eq('status', 'pending').select('id');
    if (claimed.error || !claimed.data?.length) return;
    let sentId: string | null = null;
    try {
      if (row.deadline_at && Date.now() > Date.parse(row.deadline_at)) { await this.expire(row); return; }
      const settings = await loadOwnerSettings(this.db, row.tenant_id);
      const config = behavior(settings);
      if (row.kind === 'broadcast') {
        const zone = intlTimeZone(settings.time_zone ?? 'Asia/Jerusalem');
        const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
        const today = formatter.format(new Date());
        const sent = await this.db.from('outbound_messages').select('sent_at')
          .eq('session', row.session).eq('kind', 'broadcast').eq('status', 'sent')
          .gte('sent_at', new Date(Date.now() - 48 * 60 * 60_000).toISOString());
        if (sent.error) throw new Error('Outbound proactive limit lookup failed');
        if ((sent.data ?? []).filter(item => item.sent_at && formatter.format(new Date(String(item.sent_at))) === today).length >= config.daily_proactive_limit) {
          const next = new Date(Date.now() + 24 * 60 * 60_000);
          const deferred = await this.db.from('outbound_messages').update({ status: 'pending', started_at: null, not_before: next.toISOString() }).eq('id', row.id);
          if (deferred.error) throw new Error('Outbound proactive deferral failed');
          this.wake(next); return;
        }
      }
      if (row.deadline_at && Date.now() > Date.parse(row.deadline_at)) { await this.expire(row); return; }
      if (row.kind === 'reply' || row.kind === 'owner_answer_delivery') {
        try { await this.provider.sendSeen?.({ session: row.session, chatId: row.chat_id, messageIds: row.inbound_message_ids }); }
        catch { console.error('outbound_send_seen_failed'); }
      }
      if (this.provider.startTyping) {
        try { await this.provider.startTyping({ session: row.session, chatId: row.chat_id }); }
        catch { console.error('outbound_start_typing_failed'); }
        await delay(typingDelayMs(row.text.length, config));
        try { await this.provider.stopTyping?.({ session: row.session, chatId: row.chat_id }); }
        catch { console.error('outbound_stop_typing_failed'); }
      }
      if (row.deadline_at && Date.now() + 15_000 > Date.parse(row.deadline_at)) { await this.expire(row); return; }
      const sent = await this.provider.sendMessage({ session: row.session, chatId: row.chat_id, text: row.text });
      if (!sent.id) throw new Error('Outbound send not confirmed');
      sentId = sent.id;
      const done = await this.db.from('outbound_messages').update({ status: 'sent', sent_at: new Date().toISOString(), waha_msg_id: sent.id, started_at: null })
        .eq('id', row.id).eq('status', 'sending');
      if (done.error) throw new Error('Outbound completion failed');
      try { await recordUsageEvent(this.db, { tenantId: row.tenant_id, eventType: 'message_sent', eventKey: sent.id }); }
      catch { console.error('outbound_usage_record_failed'); }
      let gap = this.provider.startTyping ? gapMs(row.kind, config) : 0;
      if (gap && gap === this.lastGaps.get(row.session)) gap++;
      this.lastGaps.set(row.session, gap);
      const readyAt = new Date(Date.now() + gap);
      this.cooldowns.set(row.session, readyAt.getTime());
      if (gap) {
        const delayed = await this.db.from('outbound_messages').update({ not_before: readyAt.toISOString() })
          .eq('session', row.session).eq('status', 'pending').lt('not_before', readyAt.toISOString());
        if (delayed.error) console.error('outbound_gap_persistence_failed');
      }
      settle(row.id, sent.id);
    } catch {
      if (sentId) {
        // A confirmed WAHA send must never be retried merely because local accounting failed.
        const uncertain = await this.db.from('outbound_messages').update({ status: 'failed', attempts: row.attempts + 1,
          last_error: 'sent_state_uncertain', waha_msg_id: sentId, started_at: null }).eq('id', row.id);
        if (uncertain.error) console.error('outbound_sent_state_persistence_failed');
        settle(row.id, new Error('Outbound sent state unavailable'));
        await logSystemEvent(this.db, { tenantId: row.tenant_id, level: 'error', event: 'outbound_sent_state_uncertain', details: { outboundId: row.id } });
        return;
      }
      const attempts = row.attempts + 1;
      const delays = (await loadOwnerSettings(this.db, row.tenant_id)).behavior?.outbound_retry_delays_seconds;
      const configured = Array.isArray(delays) && delays.length === 3 ? delays : [30, 120, 300];
      const retrySeconds = configured[attempts - 1];
      const next = retrySeconds === undefined ? null : new Date(Date.now() + Number(retrySeconds) * 1000);
      if (next && row.deadline_at && next.getTime() > Date.parse(row.deadline_at)) { await this.expire(row); return; }
      const result = await this.db.from('outbound_messages').update({ status: next ? 'pending' : 'failed', attempts,
        last_error: 'send_failed', started_at: null, ...(next ? { not_before: next.toISOString() } : {}) }).eq('id', row.id);
      if (result.error) console.error('outbound_retry_persistence_failed');
      if (next) this.wake(next);
      else {
        settle(row.id, new Error('Outbound send failed'));
        await logSystemEvent(this.db, { tenantId: row.tenant_id, level: 'error', event: 'outbound_send_failed', details: { outboundId: row.id } });
      }
    }
  }
  private async expire(row: OutboundRow): Promise<void> {
    const result = await this.db.from('outbound_messages').update({ status: 'expired', started_at: null }).eq('id', row.id);
    if (result.error) throw new Error('Outbound expiry failed');
    settle(row.id, new Error('Outbound deadline expired'));
    if (!row.deadline_at || row.kind === 'owner_notice') return;
    const settings = await loadOwnerSettings(this.db, row.tenant_id);
    const to = ownerDestination(settings);
    if (!to) return;
    const client = await this.db.from('clients').select('name,phone').eq('tenant_id',row.tenant_id).eq('whatsapp_jid',row.chat_id).maybeSingle();
    const name = typeof client.data?.name === 'string' && client.data.name.trim() ? client.data.name.trim()
      : typeof client.data?.phone === 'string' && client.data.phone.trim() ? client.data.phone.trim()
      : row.chat_id.replace(/@.*$/, '');
    const time = new Intl.DateTimeFormat('ru-RU', { timeZone: intlTimeZone(settings.time_zone ?? 'Asia/Jerusalem'), hour: '2-digit', minute: '2-digit' })
      .format(new Date(row.deadline_at));
    await enqueueMessage(this.db, row.tenant_id, this.provider, { session: row.session, chatId: to,
      text: renderText(settings, 'owner.reminder_missed', behavior(settings).owner_language, { name, time }) },
    { kind: 'owner_notice', dedupeKey: `missed:${row.id}`, waitForDelivery: false });
  }
}

export function startOutboundQueue(db: DatabaseClient = supabase, provider: WhatsAppProvider = createWhatsAppProvider()): () => void {
  let worker = processors.get(db);
  if (!worker) { worker = new OutboundProcessor(db, provider); processors.set(db, worker); }
  worker.launch();
  return () => { stopOutboundQueue(db); };
}

export async function stopOutboundQueue(db: DatabaseClient): Promise<void> {
  const worker = processors.get(db);
  worker?.stop();
  await worker?.drain();
  processors.delete(db);
}
