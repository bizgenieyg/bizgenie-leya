import { supabase, type DatabaseClient } from '../db/supabase.js';
import { JobTimer } from './job-timer.js';
import { registerJobWake } from './job-wake.js';
import { runEventJob, seedDurableJobs } from './event-jobs.js';

export function startEscalationScheduler(db: DatabaseClient = supabase): () => void {
  const timer = new JobTimer(db, job => runEventJob(db, job));
  let stopped = false;
  let retry: NodeJS.Timeout | null = null;
  let unregister = () => {};
  const start = async () => {
    try {
      await seedDurableJobs(db);
      if (stopped) return;
      unregister = registerJobWake(at => timer.scheduleWake(at));
      await timer.start();
    } catch {
      console.error('escalation_scheduler_start_failed');
      if (!stopped) {
        retry = setTimeout(() => { void start(); }, 60_000);
        retry.unref();
      }
    }
  };
  void start();
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    unregister();
    timer.stop();
  };
}
