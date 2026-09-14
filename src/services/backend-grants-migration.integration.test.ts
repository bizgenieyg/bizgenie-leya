import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const MIGRATION = 'supabase/migrations/20260909130000_033_backend_only_grants_and_function_hardening.sql';
const BACKEND_ONLY = [
  'onboarding_sessions', 'promises', 'reminders', 'services', 'subscription_addons',
  'subscriptions', 'system_logs', 'whatsapp_instances', 'work_items',
];

test('033 strips anon/authenticated grants on backend-only tables and hardens rls_auto_enable', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
      grant usage on schema public to anon,authenticated,service_role;`);
    await db.exec(readFileSync('supabase/migrations/001_phase1_schema.sql', 'utf8').replace('create extension if not exists pgcrypto;', ''));
    // Reproduce Supabase's default broad API-role grants that the audit flagged.
    await db.exec('grant all on all tables in schema public to anon, authenticated, service_role;');

    // A stand-in event-trigger function, as it exists only in the live database.
    await db.exec(`create function public.rls_auto_enable() returns event_trigger language plpgsql security definer as $$
      begin
        perform 1;
      end $$;
      grant execute on function public.rls_auto_enable() to public, anon, authenticated;`);
    let eventTriggerCreated = true;
    try {
      await db.exec(`create table public._rls_audit(obj text);
        create or replace function public.rls_auto_enable() returns event_trigger language plpgsql security definer as $$
        begin insert into public._rls_audit(obj) values (tg_tag); end $$;
        create event trigger rls_auto_enable_trg on ddl_command_end when tag in ('CREATE TABLE') execute function public.rls_auto_enable();`);
    } catch { eventTriggerCreated = false; }

    await db.exec(readFileSync(MIGRATION, 'utf8'));
    await db.exec(readFileSync(MIGRATION, 'utf8')); // idempotent

    for (const table of BACKEND_ONLY) {
      for (const role of ['anon', 'authenticated']) {
        for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          assert.equal(
            (await db.query<{ ok: boolean }>('select has_table_privilege($1, $2, $3) as ok', [role, `public.${table}`, priv])).rows[0]!.ok,
            false, `${role} must not have ${priv} on ${table}`);
        }
      }
      assert.equal(
        (await db.query<{ ok: boolean }>('select has_table_privilege($1, $2, $3) as ok', ['service_role', `public.${table}`, 'SELECT'])).rows[0]!.ok,
        true, `service_role keeps access to ${table}`);
    }

    // A tenant-facing table keeps its grant — only backend-only tables were touched.
    assert.equal(
      (await db.query<{ ok: boolean }>("select has_table_privilege('authenticated', 'public.knowledge_items', 'SELECT') as ok")).rows[0]!.ok,
      true);

    // rls_auto_enable is no longer directly callable by API roles.
    for (const role of ['anon', 'authenticated']) {
      assert.equal(
        (await db.query<{ ok: boolean }>('select has_function_privilege($1, $2, $3) as ok', [role, 'public.rls_auto_enable()', 'EXECUTE'])).rows[0]!.ok,
        false, `${role} must not execute rls_auto_enable`);
    }

    if (eventTriggerCreated) {
      // The event trigger still fires despite the revoke.
      await db.exec('create table public._probe_after_033(id int)');
      const audited = await db.query<{ obj: string }>("select obj from public._rls_audit where obj = 'CREATE TABLE'");
      assert.ok(audited.rows.length >= 1, 'event trigger continues to run after EXECUTE is revoked');
    }
  } finally {
    await db.close();
  }
});
