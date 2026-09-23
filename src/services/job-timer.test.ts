import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseClient } from '../db/supabase.js';
import { JobTimer, type ScheduledJob } from '../workers/job-timer.js';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function timerDatabase() {
  const jobs: ScheduledJob[] = [];
  let reads = 0;
  const db = {
    from(table: string) {
      assert.equal(table, 'scheduled_jobs');
      const filters: ((row: ScheduledJob) => boolean)[] = [];
      let selected = false;
      let patch: Record<string, unknown> | null = null;
      const query = {
        select() { selected = true; return query; },
        update(values: Record<string, unknown>) { patch = values; return query; },
        in(key: keyof ScheduledJob, values: string[]) { filters.push(row => values.includes(String(row[key]))); return query; },
        eq(key: keyof ScheduledJob, value: unknown) { filters.push(row => row[key] === value); return query; },
        lte(key: keyof ScheduledJob, value: string) { filters.push(row => String(row[key]) <= value); return query; },
        order() { return query; },
        limit() { return query; },
        then(resolve: (result: { data: ScheduledJob[]; error: null }) => void) {
          const matches = jobs.filter(row => filters.every(filter => filter(row)));
          if (patch) for (const row of matches) Object.assign(row, patch);
          else if (selected) reads++;
          resolve({ data: patch ? matches.map(row => ({ ...row })) : matches.slice(0, selected ? 50 : 1), error: null });
        },
      };
      return query;
    },
  } as unknown as DatabaseClient;
  return { db, jobs, get reads() { return reads; } };
}

test('idle job timer makes no further database reads after its initial lookup', async () => {
  const h = timerDatabase();
  const timer = new JobTimer(h.db, async () => {});
  await timer.start();
  const initial = h.reads;
  await wait(30);
  assert.equal(initial, 1);
  assert.equal(h.reads, initial);
  timer.stop();
});

test('earlier wake preempts one-shot timer and each job executes only once', async () => {
  const h = timerDatabase();
  const handled: string[] = [];
  const timer = new JobTimer(h.db, async job => { handled.push(job.id); });
  await timer.start();
  const later = new Date(Date.now() + 150);
  h.jobs.push({ id: 'later', tenant_id: null, job_type: 'retention_sweep', payload: {}, scheduled_at: later.toISOString(), status: 'pending' });
  timer.scheduleWake(later);
  const earlier = new Date(Date.now() + 30);
  h.jobs.push({ id: 'earlier', tenant_id: null, job_type: 'retention_sweep', payload: {}, scheduled_at: earlier.toISOString(), status: 'pending' });
  timer.scheduleWake(earlier);
  await wait(75);
  assert.deepEqual(handled, ['earlier']);
  await wait(130);
  assert.deepEqual(handled, ['earlier', 'later']);
  timer.stop();
});

test('restart executes a past-due durable job immediately', async () => {
  const h = timerDatabase();
  h.jobs.push({ id: 'old', tenant_id: null, job_type: 'retention_sweep', payload: {}, scheduled_at: new Date(Date.now() - 1000).toISOString(), status: 'pending' });
  const handled: string[] = [];
  const timer = new JobTimer(h.db, async job => { handled.push(job.id); });
  await timer.start();
  await wait(30);
  assert.deepEqual(handled, ['old']);
  timer.stop();
});
