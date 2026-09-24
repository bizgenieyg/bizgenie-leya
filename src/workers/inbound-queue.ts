import { createHash, randomUUID } from 'node:crypto';
import { supabase, type DatabaseClient } from '../db/supabase.js';
import { filterIncoming, logRejectedIncoming } from '../utils/incoming-policy.js';
import { voiceUsage } from '../services/voice-usage.service.js';
import { logSystemEvent } from '../services/logging.service.js';
import { handleWebhookEvent } from './webhook.worker.js';
import { observeOwnerOutgoing } from '../services/outgoing-owner.service.js';
import { createWhatsAppProvider } from '../providers/whatsapp/index.js';
import { getTenantRouting } from '../services/tenant.service.js';
import { handleVoiceUsage } from '../services/voice-usage.service.js';
import { sessionStatusFromWebhook, updateSessionStatus } from '../services/session-status.service.js';

export interface InboundRow {
  id: string; tenant_id: string; waha_event_id: string; chat_id: string;
  kind: string;
  payload: Record<string, unknown>; received_at: string; process_after: string;
  status: string; attempts: number;
}

const MAX_CONCURRENT = 5;
const MAX_DELAY = 2_147_000_000;
const RETRY_MS = 30_000;

let activeProcessor: InboundProcessor | null = null;
export function wakeInbound(at: Date): void { activeProcessor?.wake(at); }

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function inboundEventId(body: Record<string, unknown>): string {
  const payload = record(body.payload);
  if (body.event === 'session.status') {
    const status = typeof payload.status === 'string' ? payload.status : String(body.status ?? '');
    const stamp = typeof body.id === 'string' && body.id !== payload.id ? body.id
      : typeof body.timestamp === 'number' || typeof body.timestamp === 'string' ? String(body.timestamp) : randomUUID();
    // A session ID is stable across transitions, unlike a message ID.
    return createHash('sha256').update(`${String(body.session ?? '')}:${status}:${stamp}`).digest('hex');
  }
  const raw = payload.id ?? body.id;
  if (typeof raw === 'string' && raw) return raw;
  // Non-message events need a stable value across WAHA retries too.
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}
export function inboundChatId(body: Record<string, unknown>): string {
  const payload = record(body.payload);
  return typeof payload.from === 'string' && payload.from ? payload.from : `system:${String(body.event ?? 'unknown')}`;
}

/** Persist before the HTTP acknowledgement. Duplicate WAHA attempts are harmless. */
export async function enqueueInbound(db: DatabaseClient, tenantId: string, body: Record<string, unknown>, quietSeconds: number): Promise<boolean> {
  const now = new Date();
  const chatId = inboundChatId(body);
  const decision = filterIncoming(body);
  const isClient = decision.allowed || !!voiceUsage(body);
  const kind = isClient ? (quietSeconds > 0 ? 'client' : 'immediate') : decision.reason === 'outgoing_message' ? 'outgoing' : 'ignored';
  const due = new Date(now.getTime() + (kind === 'client' ? quietSeconds * 1000 : 0));
  const inserted = await db.from('inbound_events').insert({ tenant_id: tenantId, waha_event_id: inboundEventId(body),
    chat_id: chatId, kind, payload: body, received_at: now.toISOString(), process_after: due.toISOString(), status: 'pending' })
    .select('id').maybeSingle();
  if (inserted.error?.code === '23505') { wakeInbound(due); return false; }
  if (inserted.error || !inserted.data) throw new Error('Inbound event persistence failed');
  if (kind === 'client') {
    const shifted = await db.from('inbound_events').update({ process_after: due.toISOString() })
      .eq('tenant_id', tenantId).eq('chat_id', chatId).eq('kind', 'client').eq('status', 'pending');
    if (shifted.error) { wakeInbound(due); throw new Error('Inbound quiet window update failed'); }
  }
  wakeInbound(due);
  return true;
}

async function processRows(db: DatabaseClient, rows: InboundRow[]): Promise<void> {
  const first = rows[0]!;
  const sessionStatus = sessionStatusFromWebhook(first.payload);
  if (sessionStatus) { await updateSessionStatus(db, first.tenant_id, sessionStatus); return; }
  const decision = filterIncoming(first.payload);
  if (decision.allowed || voiceUsage(first.payload)) {
    const messages: Record<string, unknown>[] = [];
    const eventIds: string[] = [];
    let voiceAdmission: { key: string; seconds: number; unavailable?: boolean | undefined; sttKey: string; sttMetadata: Record<string, unknown> } | undefined;
    for (const row of rows) {
      if (filterIncoming(row.payload).allowed) { messages.push(row.payload); eventIds.push(row.id); }
      else if (voiceUsage(row.payload)) {
        const routing = await getTenantRouting(db, row.tenant_id);
        if (routing) await handleVoiceUsage(db, routing, row.payload, createWhatsAppProvider(), undefined, undefined,
          async (textBody, admission) => { if (!messages.length) voiceAdmission = admission; messages.push(textBody); eventIds.push(row.id); });
      }
    }
    if (messages.length) await handleWebhookEvent(first.tenant_id, messages[0]!, db, undefined, undefined,
      voiceAdmission, messages.length > 1 ? messages : undefined, eventIds);
    return;
  }
  if (decision.reason === 'outgoing_message') await observeOwnerOutgoing(db, first.tenant_id, first.payload);
  else logRejectedIncoming(decision);
}

export class InboundProcessor {
  private timer: NodeJS.Timeout | null = null;
  private timerAt = Number.POSITIVE_INFINITY;
  private readonly chats = new Set<string>();
  private active = 0;
  private stopped = false;
  private refreshing = false;
  private scanning = false;
  private wakeVersion = 0;
  private scanAgain = false;

  constructor(private readonly db: DatabaseClient,
    private readonly process: (db: DatabaseClient, rows: InboundRow[]) => Promise<void> = processRows) {}

  async start(): Promise<void> {
    await this.recoverStale();
    activeProcessor = this;
    await this.refresh();
  }

  // Only at process start: leya-api runs as a single PM2 instance, so every `processing` row
  // left behind belongs to a dead process. Never reclaim rows while this process is alive.
  private async recoverStale(): Promise<void> {
    const stale = await this.db.from('inbound_events').update({ status: 'pending', process_after: new Date().toISOString(), started_at: null })
      .eq('status', 'processing');
    if (stale.error) throw new Error('Inbound recovery failed');
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (activeProcessor === this) activeProcessor = null;
  }

  wake(at: Date): void {
    this.wakeVersion++;
    const target = at.getTime();
    if (this.stopped || !Number.isFinite(target)) return;
    if (this.scanning && target <= Date.now()) this.scanAgain = true;
    if (target >= this.timerAt) return;
    this.arm(target);
  }

  private arm(at: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (at > Date.now()) this.arm(at);
      else void this.fire();
    }, Math.min(Math.max(0, at - Date.now()), MAX_DELAY));
    this.timer.unref();
  }

  private async refresh(): Promise<void> {
    if (this.stopped || this.refreshing) return;
    this.refreshing = true;
    const version = this.wakeVersion;
    try {
      const next = await this.db.from('inbound_events').select('tenant_id,chat_id,process_after').eq('status', 'pending')
        .order('process_after', { ascending: true }).limit(200);
      if (next.error) throw new Error('Inbound next-event lookup failed');
      if (this.stopped) return;
      const ready = (next.data ?? []).find(row => !this.chats.has(`${row.tenant_id}:${row.chat_id}`));
      const pendingAt = ready ? new Date(String(ready.process_after)).getTime() : Number.POSITIVE_INFINITY;
      const target = pendingAt;
      if (version !== this.wakeVersion && this.timerAt < target) return;
      if (!Number.isFinite(target)) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null; this.timerAt = Number.POSITIVE_INFINITY;
      } else this.arm(target);
    } finally { this.refreshing = false; }
  }

  private async fire(): Promise<void> {
    if (this.stopped) return;
    if (this.scanning || this.active >= MAX_CONCURRENT) { this.scanAgain = true; return; }
    this.scanning = true;
    try {
      const now = new Date();
      const due = await this.db.from('inbound_events').select('id,tenant_id,waha_event_id,chat_id,kind,payload,received_at,process_after,status,attempts')
        .eq('status', 'pending').lte('process_after', now.toISOString())
        .order('process_after', { ascending: true }).limit(50);
      if (due.error) throw new Error('Inbound due-event lookup failed');
      for (const row of due.data ?? []) {
        if (this.active >= MAX_CONCURRENT) break;
        const event = row as InboundRow;
        const key = `${event.tenant_id}:${event.chat_id}`;
        if (this.chats.has(key)) continue;
        this.chats.add(key); this.active++;
        void this.processChat(event, now).catch(() => {
          console.error('inbound_chat_claim_failed');
          this.arm(Date.now() + RETRY_MS);
        }).finally(() => {
          this.chats.delete(key); this.active--;
          void this.fire();
        });
      }
      // A due chat may be processing while another chat's quiet window expires.
      // Keep the next database deadline armed even when this scan found work.
      await this.refresh();
    } catch {
      console.error('inbound_processor_wake_failed');
      this.arm(Date.now() + RETRY_MS);
    } finally {
      this.scanning = false;
      if (this.scanAgain && this.active < MAX_CONCURRENT) {
        this.scanAgain = false;
        queueMicrotask(() => { void this.fire(); });
      }
    }
  }

  private async processChat(first: InboundRow, now: Date): Promise<void> {
    let query = this.db.from('inbound_events').select('id,tenant_id,waha_event_id,chat_id,kind,payload,received_at,process_after,status,attempts')
      .eq('tenant_id', first.tenant_id).eq('chat_id', first.chat_id).eq('status', 'pending');
    query = first.kind === 'client' ? query.eq('kind', 'client') : query.eq('id', first.id);
    const found = await query.lte('process_after', now.toISOString()).order('received_at', { ascending: true }).limit(50);
    if (found.error) throw new Error('Inbound batch lookup failed');
    const rows = found.data as InboundRow[] | null;
    if (!rows?.length) return;
    const ids = rows.map(row => row.id);
    const claim = await this.db.from('inbound_events').update({ status: 'processing', started_at: now.toISOString() })
      .in('id', ids).eq('status', 'pending').lte('process_after', now.toISOString()).select('id');
    if (claim.error) throw new Error('Inbound claim failed');
    const claimed = new Set((claim.data ?? []).map(row => String(row.id)));
    const batch = rows.filter(row => claimed.has(row.id));
    if (!batch.length) return;
    try {
      await this.process(this.db, batch);
      const decision = filterIncoming(batch[0]!.payload);
      const ignored = !decision.allowed && !voiceUsage(batch[0]!.payload) && decision.reason !== 'outgoing_message';
      const done = await this.db.from('inbound_events').update({ status: ignored ? 'ignored' : 'done', processed_at: new Date().toISOString(), error: null })
        .in('id', batch.map(row => row.id)).eq('status', 'processing');
      if (done.error) throw new Error('Inbound completion failed');
    } catch {
      for (const row of batch) {
        const attempts = row.attempts + 1;
        const final = attempts >= 3;
        const retry = new Date(Date.now() + RETRY_MS);
        const failed = await this.db.from('inbound_events').update({ status: final ? 'failed' : 'pending', attempts,
          error: 'processing_failed', process_after: retry.toISOString(), processed_at: final ? new Date().toISOString() : null,
          started_at: null }).eq('id', row.id).eq('status', 'processing');
        if (failed.error) console.error('inbound_retry_persistence_failed');
        if (final) await logSystemEvent(this.db, { tenantId: row.tenant_id, level: 'error', event: 'inbound_processing_failed', details: { eventId: row.id } });
        else this.wake(retry);
      }
    }
  }
}

export function startInboundQueue(db: DatabaseClient = supabase): () => void {
  const worker = new InboundProcessor(db);
  let stopped = false;
  let retry: NodeJS.Timeout | null = null;
  const start = async () => {
    try { await worker.start(); }
    catch {
      console.error('inbound_queue_start_failed');
      if (!stopped) { retry = setTimeout(() => { void start(); }, RETRY_MS); retry.unref(); }
    }
  };
  void start();
  return () => { stopped = true; if (retry) clearTimeout(retry); worker.stop(); };
}
