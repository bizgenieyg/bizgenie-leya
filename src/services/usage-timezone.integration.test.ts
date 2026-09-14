import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

// Blocker regression: notification_settings.time_zone holds product labels like 'UTC+3',
// which Postgres reads the POSIX way (3 hours WEST) inside timezone()/at time zone. Migration
// 031 translates them to their IANA equivalents (Etc/GMT has the opposite sign) at the point
// of use, so a tenant's month boundary and usage period land on the right calendar month.
test('031 usage RPCs honour UTC offsets with the correct sign at month boundaries', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
      create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to anon,authenticated,service_role;
      create table tenant_users(tenant_id uuid,user_id uuid,role text);grant select on tenant_users to authenticated;`);
    await db.exec(readFileSync('supabase/migrations/001_phase1_schema.sql', 'utf8').replace('create extension if not exists pgcrypto;', ''));
    await db.exec(readFileSync('supabase/migrations/003_phase1_rls.sql', 'utf8'));
    await db.exec(readFileSync('supabase/migrations/20260908114713_024_owner_escalation_workflow.sql', 'utf8'));
    await db.exec('grant all on all tables in schema public to service_role;grant insert,update,delete on usage_events to authenticated;');
    await db.exec(readFileSync('supabase/migrations/20260908164604_025_tenant_usage_limits.sql', 'utf8'));
    await db.exec(readFileSync('supabase/migrations/20260908174719_026_runtime_behavior_and_agents.sql', 'utf8'));
    await db.exec(readFileSync('supabase/migrations/20260909120000_031_usage_timezone_offset_fix.sql', 'utf8'));
    // Idempotent re-apply, like the other migration tests.
    await db.exec(readFileSync('supabase/migrations/20260909120000_031_usage_timezone_offset_fix.sql', 'utf8'));

    // 1. The translation helper mirrors intlTimeZone() in src/config/time-zones.ts.
    const iana = async (zone: string) =>
      (await db.query<{ z: string }>('select public.iana_time_zone($1) as z', [zone])).rows[0]!.z;
    assert.equal(await iana('UTC+3'), 'Etc/GMT-3');
    assert.equal(await iana('UTC-5'), 'Etc/GMT+5');
    assert.equal(await iana('UTC'), 'UTC');
    assert.equal(await iana('UTC+0'), 'UTC');
    assert.equal(await iana('Asia/Jerusalem'), 'Asia/Jerusalem');

    // 2. Raw label vs translated label — the exact defect the review reproduced.
    const probe = await db.query<{ buggy: string; fixed: string }>(
      `select date_trunc('month', timezone('UTC+3', timestamptz '2026-09-01 01:00:00+00'))::date::text as buggy,
              date_trunc('month', timezone(public.iana_time_zone('UTC+3'), timestamptz '2026-09-01 01:00:00+00'))::date::text as fixed`);
    assert.equal(probe.rows[0]!.buggy, '2026-08-01');
    assert.equal(probe.rows[0]!.fixed, '2026-09-01');

    const east = '10000000-0000-4000-8000-000000000001'; // UTC+3
    const west = '10000000-0000-4000-8000-000000000002'; // UTC-5
    await db.query("insert into tenants(id,name,phone) values($1,'East','1'),($2,'West','2')", [east, west]);
    await db.query("insert into notification_settings(tenant_id,time_zone) values($1,'UTC+3'),($2,'UTC-5')", [east, west]);
    await db.query('insert into tenant_usage_limits(tenant_id,messages_per_month,voice_minutes_per_month) values($1,500,60),($2,500,60)', [east, west]);
    await db.exec('set role service_role');

    let key = 0;
    const month = async (tenant: string, now: string) =>
      String((await db.query<{ v: { month: string } }>(
        'select admit_tenant_usage($1,$2,1,0,500,3600,80,$3) as v', [tenant, `k${key++}`, now])).rows[0]!.v.month).slice(0, 10);
    const period = async (tenant: string, now: string) => {
      const v = (await db.query<{ v: { period_start: string; period_end: string; time_zone: string } }>(
        'select tenant_usage_summary($1,500,3600,$2) as v', [tenant, now])).rows[0]!.v;
      return { start: new Date(v.period_start).toISOString(), end: new Date(v.period_end).toISOString(), zone: v.time_zone };
    };

    // Positive offset: 01:00Z on the 1st is already the 1st locally (04:00), not the previous month.
    assert.equal(await month(east, '2026-09-01T01:00:00Z'), '2026-09-01');
    // Positive offset, exact local midnight of the 1st (21:00Z on the 31st).
    assert.equal(await month(east, '2026-08-31T21:00:00Z'), '2026-09-01');
    assert.equal(await month(east, '2026-08-31T20:59:00Z'), '2026-08-01');

    // Negative offset: 21:00Z on the 31st is still the 31st locally (16:00) — August, not September.
    assert.equal(await month(west, '2026-08-31T21:00:00Z'), '2026-08-01');
    // Negative offset, exact local midnight of the 1st (05:00Z on the 1st).
    assert.equal(await month(west, '2026-09-01T05:00:00Z'), '2026-09-01');
    assert.equal(await month(west, '2026-09-01T04:59:00Z'), '2026-08-01');

    // Usage period bounds follow the tenant's real local month, offset applied with the right sign.
    const eastPeriod = await period(east, '2026-09-15T12:00:00Z');
    assert.equal(eastPeriod.start, '2026-08-31T21:00:00.000Z');
    assert.equal(eastPeriod.end, '2026-09-30T21:00:00.000Z');
    assert.equal(eastPeriod.zone, 'UTC+3');
    const westPeriod = await period(west, '2026-09-15T12:00:00Z');
    assert.equal(westPeriod.start, '2026-09-01T05:00:00.000Z');
    assert.equal(westPeriod.end, '2026-10-01T05:00:00.000Z');
    assert.equal(westPeriod.zone, 'UTC-5');

    // Named IANA zones keep working unchanged.
    await db.query("update notification_settings set time_zone='America/New_York' where tenant_id=$1", [west]);
    assert.equal(await month(west, '2026-09-01T03:00:00Z'), '2026-08-01'); // 23:00 EDT on the 31st
  } finally {
    await db.close();
  }
});
