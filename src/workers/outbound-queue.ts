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
import { replyId } from '../utils/assistant-text.js';
import { senderKey } from '../utils/whatsapp-id.js';
import { BEHAVIOR_DEFAULTS } from '../config/behavior.js';

export type OutboundKind = 'reply' | 'owner_notice' | 'owner_answer_delivery' | 'summary' | 'reminder' | 'broadcast';
export interface OutboundRow {
  id: string; tenant_id: string; session: string; chat_id: string; text: string; kind: OutboundKind;
  priority: number; not_before: string; deadline_at: string | null; status: string;
  attempts: number; dedupe_key: string; inbound_message_ids: string[]; created_at: string; started_at: string | null;
}
export interface EnqueueOptions {
  kind?: OutboundKind; dedupeKey?: string; notBefore?: Date; deadlineAt?: Date;
  inboundMessageIds?: string[];
}
const MAX_CONCURRENT = 5;
const MAX_DELAY = 2_147_000_000;
const processors = new WeakMap<DatabaseClient, OutboundProcessor>();
const liveDatabases = new Set<DatabaseClient>();

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

/**
 * Accept → persist → release: never waits for delivery. Returns the `outbound_messages` row id;
 * the sender later stamps `waha_msg_id` on that row and on any `messages` row linked to it.
 */
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
  if (['failed', 'cancelled', 'expired'].includes(row.status)) throw new Error('Outbound message unavailable');
  if (row.status === 'sent') return { id: row.id };
  let processor = processors.get(db);
  if (!processor) {
    processor = new OutboundProcessor(db, provider);
    processors.set(db, processor); liveDatabases.add(db);
  }
  processor.launch();
  processor.wake(new Date(payload.not_before));
  return { id: row.id };
}

/** Provider ids and ids of our own outbound rows that a quoted/echoed WhatsApp id may refer to. */
export async function outboundIdsForProviderId(db: DatabaseClient, tenantId: string, providerId: string): Promise<string[]> {
  if (!providerId) return [];
  const short = replyId(providerId);
  const rows = await db.from('outbound_messages').select('id,waha_msg_id').eq('tenant_id', tenantId).like('waha_msg_id', `%${short}`);
  if (rows.error) throw new Error('Outbound id lookup failed');
  return (rows.data ?? []).filter(row => typeof row.waha_msg_id === 'string' && (row.waha_msg_id === providerId || replyId(row.waha_msg_id) === short))
    .map(row => String(row.id));
}

/** Scheduled client reminders may move earlier but never past the event they describe. */
export async function enqueuePlannedReminder(db: DatabaseClient, tenantId: string, provider: WhatsAppProvider,
  input: SendMessageInput, schedule: { sendAt: Date; eventAt: Date; dedupeKey: string }): Promise<{ id: string }> {
  const settings = await loadOwnerSettings(db, tenantId);
  const notBefore = plannedNotBefore(new Date(), schedule.sendAt, behavior(settings).outbound_reminder_spread_minutes);
  return enqueueMessage(db, tenantId, provider, input, { kind: 'reminder', dedupeKey: schedule.dedupeKey,
    notBefore, deadlineAt: schedule.eventAt });
}

/**
 * Cancel pending replies to one contact. A contact may be addressed as `@lid` or `@c.us`
 * (`@s.whatsapp.net`); callers pass every id known for it and rows match through senderKey.
 */
export async function cancelPendingReplies(db: DatabaseClient, tenantId: string, chatIds: string | string[]): Promise<void> {
  const pending = await db.from('outbound_messages').select('id,chat_id')
    .eq('tenant_id', tenantId).eq('kind', 'reply').eq('status', 'pending');
  if (pending.error) throw new Error('Outbound cancellation failed');
  const keys = new Set((Array.isArray(chatIds) ? chatIds : [chatIds]).filter(Boolean).map(senderKey));
  const ids = (pending.data ?? []).filter(row => keys.has(senderKey(String(row.chat_id)))).map(row => String(row.id));
  if (!ids.length) return;
  const cancelled = await db.from('outbound_messages').update({ status: 'cancelled' }).in('id', ids).eq('status', 'pending');
  if (cancelled.error) throw new Error('Outbound cancellation failed');
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

  // Only at process start (single leya-api instance): a `sending` row belongs to a dead process.
  private async recoverStale(): Promise<void> {
    const stale = await this.db.from('outbound_messages').update({ status: 'pending', started_at: null })
      .eq('status', 'sending');
    if (stale.error) throw new Error('Outbound recovery failed');
  }

  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); if (this.retryTimer) clearTimeout(this.retryTimer); }
  async drain(): Promise<void> { if (this.startup) await this.startup; while (this.scanning || this.tasks.size) { await Promise.allSettled([...this.tasks]); if (this.scanning) await delay(10); } }
  wake(at: Date): void {
    this.wakeVersion++;
    if (this.stopped) return;
    if (this.scanning && at.getTime() <= Date.now()) this.scanAgain = true;
    if (at.getTime() < this.timerAt) this.arm(at.getTime());
  }
  private arm(at: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => { this.timer = null; if (at > Date.now()) this.arm(at); else void this.fire(); },
      Math.min(Math.max(0, at - Date.now()), MAX_DELAY));
    this.timer.unref();
  }
  private async refresh(): Promise<void> {
    if (this.stopped) return;
    const version = this.wakeVersion;
    const next = await this.db.from('outbound_messages').select('session,not_before').eq('status', 'pending')
      .order('not_before', { ascending: true }).limit(200);
    if (next.error) throw new Error('Outbound next-event lookup failed');
    const pending = (next.data ?? []).filter(row => !this.sessions.has(String(row.session)));
    const pendingAt = pending.reduce((earliest, row) => Math.min(earliest,
      Math.max(new Date(String(row.not_before)).getTime(), this.cooldowns.get(String(row.session)) ?? 0)), Number.POSITIVE_INFINITY);
    const target = pendingAt;
    if (this.stopped || (version !== this.wakeVersion && this.timerAt < target)) return;
    if (!Number.isFinite(target)) { if (this.timer) clearTimeout(this.timer); this.timer = null; this.timerAt = Number.POSITIVE_INFINITY; }
    else this.arm(target);
  }
  private async fire(): Promise<void> {
    if (this.stopped) return;
    if (this.scanning || this.active >= MAX_CONCURRENT) { this.scanAgain = true; return; }
    this.scanning = true;
    try {
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
      const linked = await this.db.from('messages').update({ waha_msg_id: sent.id }).eq('tenant_id', row.tenant_id).eq('outbound_message_id', row.id);
      if (linked.error) console.error('outbound_message_link_failed');
      if (row.kind === 'owner_answer_delivery') await this.ownerAnswerOutcome(row, 'sent');
      try { await recordUsageEvent(this.db, { tenantId: row.tenant_id, eventType: 'message_sent', eventKey: sent.id }); }
      catch { console.error('outbound_usage_record_failed'); }
      let gap = this.provider.startTyping ? gapMs(row.kind, config) : 0;
      if (gap && gap === this.lastGaps.get(row.session)) gap++;
      this.lastGaps.set(row.session, gap);
      const readyAt = new Date(Date.now() + gap);
      this.cooldowns.set(row.session, readyAt.getTime());
      if (gap) {
        const delayed = await this.db.from('outbound_messages').update({ not_before: readyAt.toISOString() })
          .eq('session', row.session).eq('status', 'pending').is('deadline_at', null).lt('not_before', readyAt.toISOString());
        if (delayed.error) console.error('outbound_gap_persistence_failed');
      }
    } catch {
      if (sentId) {
        // A confirmed WAHA send must never be retried merely because local accounting failed.
        const uncertain = await this.db.from('outbound_messages').update({ status: 'failed', attempts: row.attempts + 1,
          last_error: 'sent_state_uncertain', waha_msg_id: sentId, started_at: null }).eq('id', row.id);
        if (uncertain.error) console.error('outbound_sent_state_persistence_failed');
        await logSystemEvent(this.db, { tenantId: row.tenant_id, level: 'error', event: 'outbound_sent_state_uncertain', details: { outboundId: row.id } });
        return;
      }
      const attempts = row.attempts + 1;
      const delays = behavior(await loadOwnerSettings(this.db, row.tenant_id)).outbound_retry_delays_seconds;
      const configured = Array.isArray(delays) && delays.length === 3 ? delays : BEHAVIOR_DEFAULTS.outbound_retry_delays_seconds;
      const retrySeconds = configured[attempts - 1];
      const next = retrySeconds === undefined ? null : new Date(Date.now() + Number(retrySeconds) * 1000);
      if (next && row.deadline_at && next.getTime() > Date.parse(row.deadline_at)) { await this.expire(row); return; }
      const result = await this.db.from('outbound_messages').update({ status: next ? 'pending' : 'failed', attempts,
        last_error: 'send_failed', started_at: null, ...(next ? { not_before: next.toISOString() } : {}) }).eq('id', row.id);
      if (result.error) console.error('outbound_retry_persistence_failed');
      if (next) this.wake(next);
      else {
        await logSystemEvent(this.db, { tenantId: row.tenant_id, level: 'error', event: 'outbound_send_failed', details: { outboundId: row.id } });
        if (row.kind === 'owner_answer_delivery') await this.ownerAnswerOutcome(row, 'failed');
      }
    }
  }
  private async ownerAnswerOutcome(row: OutboundRow, outcome: 'sent' | 'failed'): Promise<void> {
    try {
      const { onOwnerAnswerDeliveryOutcome } = await import('../services/owner-workflow.service.js');
      await onOwnerAnswerDeliveryOutcome(this.db, this.provider, row, outcome);
    } catch { console.error('owner_answer_outcome_failed', { tenantId: row.tenant_id }); }
  }
  private async expire(row: OutboundRow): Promise<void> {
    const result = await this.db.from('outbound_messages').update({ status: 'expired', started_at: null }).eq('id', row.id);
    if (result.error) throw new Error('Outbound expiry failed');
    if (row.kind === 'owner_answer_delivery') await this.ownerAnswerOutcome(row, 'failed');
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
    { kind: 'owner_notice', dedupeKey: `missed:${row.id}` });
  }
}

export function startOutboundQueue(db: DatabaseClient = supabase, provider: WhatsAppProvider = createWhatsAppProvider()): () => void {
  let worker = processors.get(db);
  if (!worker) { worker = new OutboundProcessor(db, provider); processors.set(db, worker); liveDatabases.add(db); }
  worker.launch();
  return () => { stopOutboundQueue(db); };
}

/** Wait until every due outbound row has been processed (tests, graceful shutdown). */
export async function settleOutboundQueue(db: DatabaseClient, maxRounds = 500): Promise<void> {
  for (let round = 0; round < maxRounds; round++) {
    const worker = processors.get(db);
    if (!worker) return;
    await worker.drain();
    const due = await db.from('outbound_messages').select('id').in('status', ['pending', 'sending'])
      .lte('not_before', new Date().toISOString()).limit(1);
    if (due.error) throw new Error('Outbound settle lookup failed');
    if (!due.data?.length) return;
    worker.wake(new Date());
    await delay(5);
  }
  throw new Error('Outbound queue did not settle');
}

export async function stopOutboundQueue(db: DatabaseClient): Promise<void> {
  const worker = processors.get(db);
  worker?.stop();
  await worker?.drain();
  processors.delete(db); liveDatabases.delete(db);
}

/** Test helper: settle every running outbound queue in this process. */
export async function settleAllOutboundQueues(): Promise<void> {
  for (const db of [...liveDatabases]) {
    try { await settleOutboundQueue(db); } catch { liveDatabases.delete(db); }
  }
}
