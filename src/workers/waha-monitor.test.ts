import assert from 'node:assert/strict';
import test from 'node:test';
import { WahaMonitor } from './waha-monitor.js';
import type { DatabaseClient } from '../db/supabase.js';

test('WAHA monitor requires two failures before marking service down', async () => {
  let reads = 0;
  const db = { from: () => { reads++; throw new Error('No database read on failures'); } } as unknown as DatabaseClient;
  const monitor = new WahaMonitor(db, async () => { throw new Error('offline'); });
  await monitor.check();
  await monitor.check();
  assert.equal(reads, 0);
});
