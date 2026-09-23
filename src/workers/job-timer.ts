import type { DatabaseClient } from '../db/supabase.js';

export interface ScheduledJob {
  id: string;
  tenant_id: string | null;
  job_type: string;
  payload: Record<string, unknown>;
  scheduled_at: string;
  status: string;
}

const JOB_TYPES = ['owner_escalation', 'escalation_timeout', 'owner_summary', 'retention_sweep'];
const MAX_TIMEOUT_MS = 2_147_000_000;
const LEASE_MS = 5 * 60_000;
const RETRY_MS = 60_000;

/** One database-backed wake-up for the earliest durable job, with no idle polling. */
export class JobTimer {
  private timer: NodeJS.Timeout | null = null;
  private wakeAt = Number.POSITIVE_INFINITY;
  private running = false;
  private stopped = false;
  private wakeRevision = 0;

  constructor(private readonly db: DatabaseClient, private readonly handle: (job: ScheduledJob) => Promise<void>) {}

  async start(): Promise<void> { await this.refresh(); }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  scheduleWake(at: Date): void {
    const time = at.getTime();
    if (this.stopped || !Number.isFinite(time)) return;
    this.wakeRevision++;
    if (this.running || time >= this.wakeAt) return;
    this.arm(time);
  }

  private arm(at: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.wakeAt = at;
    const remaining = Math.max(0, at - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      if (at - Date.now() > 0) this.arm(at); // Node timers cannot span more than ~24.8 days.
      else void this.fire();
    }, Math.min(remaining, MAX_TIMEOUT_MS));
    this.timer.unref();
  }

  private async refresh(): Promise<void> {
    if (this.stopped) return;
    const revision = this.wakeRevision;
    const next = await this.db.from('scheduled_jobs').select('scheduled_at')
      .in('job_type', JOB_TYPES).in('status', ['pending', 'sending'])
      .order('scheduled_at', { ascending: true }).limit(1);
    if (next.error) throw new Error('Could not read next scheduled job');
    if (this.stopped || revision !== this.wakeRevision) {
      if (!this.running) void this.refresh();
      return;
    }
    if (!next.data?.length) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.wakeAt = Number.POSITIVE_INFINITY;
      return;
    }
    this.arm(new Date(String(next.data[0]!.scheduled_at)).getTime());
  }

  private async fire(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    let failed = false;
    try {
      for (;;) {
        const now = new Date();
        const due = await this.db.from('scheduled_jobs').select('id,tenant_id,job_type,payload,scheduled_at,status')
          .in('job_type', JOB_TYPES).in('status', ['pending', 'sending'])
          .lte('scheduled_at', now.toISOString()).order('scheduled_at', { ascending: true }).limit(50);
        if (due.error) throw new Error('Could not read due scheduled jobs');
        if (!due.data?.length) break;
        for (const row of due.data as ScheduledJob[]) await this.runOne(row);
      }
    } catch {
      console.error('job_timer_failed');
      failed = true;
    } finally {
      this.running = false;
      if (failed) { this.arm(Date.now() + RETRY_MS); return; }
      try { await this.refresh(); }
      catch {
        // A failed database read is not an idle poll: retry this failed wake-up once.
        this.arm(Date.now() + RETRY_MS);
      }
    }
  }

  private async runOne(job: ScheduledJob): Promise<void> {
    // Owner summaries already own a conditional claim and lease in claimSummary().
    if (job.job_type === 'owner_summary') {
      try { await this.handle(job); }
      catch { console.error('scheduled_job_failed', { jobType: job.job_type, jobId: job.id }); }
      const retry = await this.db.from('scheduled_jobs').update({ status: 'pending', scheduled_at: new Date(Date.now() + RETRY_MS).toISOString() })
        .eq('id', job.id).eq('status', job.status).eq('scheduled_at', job.scheduled_at);
      if (retry.error) console.error('scheduled_job_retry_failed', { jobType: job.job_type, jobId: job.id });
      return;
    }
    const lease = new Date(Date.now() + LEASE_MS).toISOString();
    const claimed = await this.db.from('scheduled_jobs').update({ status: 'sending', scheduled_at: lease })
      .eq('id', job.id).eq('status', job.status).eq('scheduled_at', job.scheduled_at).select('id');
    if (claimed.error) throw new Error('Could not claim scheduled job');
    if (!claimed.data?.length) return;
    try {
      await this.handle(job);
      const done = await this.db.from('scheduled_jobs').update({ status: 'done', executed_at: new Date().toISOString(), error: null })
        .eq('id', job.id).eq('status', 'sending').eq('scheduled_at', lease);
      if (done.error) throw new Error('Could not finish scheduled job');
    } catch {
      console.error('scheduled_job_failed', { jobType: job.job_type, jobId: job.id });
      const retry = await this.db.from('scheduled_jobs').update({ status: 'pending', scheduled_at: new Date(Date.now() + RETRY_MS).toISOString(), error: 'job_failed' })
        .eq('id', job.id).eq('status', 'sending').eq('scheduled_at', lease);
      if (retry.error) console.error('scheduled_job_retry_failed', { jobType: job.job_type, jobId: job.id });
    }
  }
}
