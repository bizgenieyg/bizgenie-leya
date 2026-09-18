import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { DatabaseClient } from '../../db/supabase.js';

/**
 * Shared PGlite test harness: boots a real Postgres (via PGlite) with the actual
 * migration files applied, in the order they were really applied to the live
 * database (022/023 predate 024 in application history even though their
 * filenames were timestamped later when they were merged in from the admin
 * repo — see migration 034's header comment). This is deliberately NOT the
 * plain filename-sort order.
 *
 * Using the real .sql files (not a hand-typed subset of the schema) is the
 * whole point: a hand-rolled mock DB cannot enforce column types, foreign
 * keys, CHECK constraints or function bodies, so it silently accepts data a
 * real Postgres would reject. That gap is exactly what let the simulator's
 * `simulation-${uuid}` non-UUID id ship as "tested" (see simulator.service.ts
 * history) while every mock-backed test stayed green.
 */
const MIGRATIONS_IN_APPLICATION_ORDER = [
  '001_phase1_schema.sql',
  '002_phase1_indexes.sql',
  '003_phase1_rls.sql',
  // tenant_users is referenced by 004's RLS policies but is not created by
  // 001-003; on the live database it predates 004 (022/023 were merged in
  // from the admin repo later and given later filenames, but were actually
  // applied before 004 — see migration 034's header comment). Apply them
  // here, in real chronological order, not filename order.
  '20260909131000_022_tenant_users.sql',
  '20260909132000_023_create_tenant_with_owner.sql',
  '004_admin_onboarding_rls.sql',
  '20260828103416_reports_query_indexes.sql',
  '20260830094810_whatsapp_instance_per_tenant.sql',
  '20260908114713_024_owner_escalation_workflow.sql',
  '20260908164604_025_tenant_usage_limits.sql',
  '20260908174719_026_runtime_behavior_and_agents.sql',
  '20260909041638_027_system_tenant_settings_and_calendar.sql',
  '20260909073722_028_conversation_takeover_and_memory.sql',
  '20260909075742_029_reception_routing.sql',
  '20260909081326_030_reception_conversation.sql',
  '20260909120000_031_usage_timezone_offset_fix.sql',
  '20260909121000_032_message_retention_and_route_cleanup.sql',
  '20260909130000_033_backend_only_grants_and_function_hardening.sql',
  '20260909133000_034_tenant_provisioning_limits.sql',
  '20260909134000_036_tenant_creation_advisory_lock.sql',
  '20260909135000_035_drop_legacy_create_tenant_signature.sql',
  '20260910100000_037_plans_and_tenant_usage_defaults.sql',
  '20260910110000_038_plan_integrity_and_pilot.sql',
  '20260910111000_039_drop_duplicate_messages_index.sql',
  '20260910120000_040_client_cards_and_owner_summaries.sql',
  '20260910130000_041_client_soft_delete_and_job_contracts.sql',
  '20260911181238_042_assistant_tone_values.sql',
  '20260914132216_043_pause_new_tenant_replies.sql',
  '20260915054310_044_client_reply_language_and_group_cleanup.sql',
  // 045 needs the pgvector extension, which this PGlite build does not have; its own
  // integration tests boot a dedicated instance instead of using this shared harness.
  '20260917090000_046_client_chat_type.sql',
  // A migration numbered 047 that merged clients by (tenant, JID digits, name) was
  // drafted and committed but never applied to the live database (confirmed via
  // Supabase's migration history) and never reached `supabase db push` or manual SQL.
  // It was removed outright rather than reverted forward, and 047 was reassigned to
  // this unrelated reset function — no gap, no orphaned "revert" migration.
  '20260918101000_047_reset_tenant_customer_data.sql',
];

/** PGlite has no real `auth` schema/GoTrue; stub just enough for RLS-authoring
 * migrations (auth.users FK target, auth.uid() used only inside SECURITY
 * DEFINER functions our service-role tests never invoke as `authenticated`). */
async function bootstrapAuthAndRoles(pg: PGlite): Promise<void> {
  await pg.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key default gen_random_uuid());
    create function auth.uid() returns uuid language sql stable
      as $$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
    grant usage on schema public, auth to anon, authenticated, service_role;
  `);
}

export async function createTestDatabase(): Promise<PGlite> {
  const pg = new PGlite();
  await bootstrapAuthAndRoles(pg);
  for (const file of MIGRATIONS_IN_APPLICATION_ORDER) {
    const sql = readFileSync(`supabase/migrations/${file}`, 'utf8')
      // PGlite ships gen_random_uuid() built in and does not support CREATE EXTENSION.
      .replace('create extension if not exists pgcrypto;', '');
    try {
      await pg.exec(sql);
    } catch (error) {
      throw new Error(`Migration ${file} failed to apply to the PGlite test database: ${(error as Error).message}`);
    }
  }
  return pg;
}

// ---------------------------------------------------------------------------
// A small PostgREST-style query builder over a PGlite connection. It covers
// only the operators the backend actually calls (grep-verified per test file
// converted to this harness) — this is a test adapter, not a client library.
// ---------------------------------------------------------------------------

type Filter =
  | { kind: 'eq' | 'neq' | 'gte' | 'lte' | 'gt' | 'lt'; column: string; value: unknown }
  | { kind: 'in'; column: string; value: unknown[] }
  | { kind: 'is'; column: string; value: null | boolean }
  | { kind: 'not_is'; column: string; value: null }
  | { kind: 'contains'; column: string; value: unknown };

function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

class PgliteQueryBuilder {
  private filters: Filter[] = [];
  private columns = '*';
  private orderBy: { column: string; ascending: boolean } | null = null;
  private limitN: number | null = null;
  private mode: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
  private payload: Record<string, unknown> | Record<string, unknown>[] | null = null;
  private wantSingle: 'maybe' | 'strict' | null = null;
  private conflictColumn = 'id';

  constructor(private pg: PGlite, private table: string) {}

  select(columns = '*'): this { if (this.mode === 'select') this.columns = columns; else this.columns = columns; return this; }
  eq(column: string, value: unknown): this { this.filters.push({ kind: 'eq', column, value }); return this; }
  neq(column: string, value: unknown): this { this.filters.push({ kind: 'neq', column, value }); return this; }
  gte(column: string, value: unknown): this { this.filters.push({ kind: 'gte', column, value }); return this; }
  lte(column: string, value: unknown): this { this.filters.push({ kind: 'lte', column, value }); return this; }
  gt(column: string, value: unknown): this { this.filters.push({ kind: 'gt', column, value }); return this; }
  lt(column: string, value: unknown): this { this.filters.push({ kind: 'lt', column, value }); return this; }
  in(column: string, value: unknown[]): this { this.filters.push({ kind: 'in', column, value }); return this; }
  is(column: string, value: null | boolean): this { this.filters.push({ kind: 'is', column, value }); return this; }
  not(column: string, _operator: string, value: null): this { this.filters.push({ kind: 'not_is', column, value }); return this; }
  contains(column: string, value: unknown): this { this.filters.push({ kind: 'contains', column, value }); return this; }
  order(column: string, options?: { ascending?: boolean }): this { this.orderBy = { column, ascending: options?.ascending !== false }; return this; }
  limit(n: number): this { this.limitN = n; return this; }
  insert(value: Record<string, unknown> | Record<string, unknown>[]): this { this.mode = 'insert'; this.payload = value; return this; }
  update(value: Record<string, unknown>): this { this.mode = 'update'; this.payload = value; return this; }
  upsert(value: Record<string, unknown>, options?: { onConflict?: string }): this { this.mode = 'upsert'; this.payload = value; this.conflictColumn = options?.onConflict ?? 'id'; return this; }
  delete(): this { this.mode = 'delete'; return this; }
  maybeSingle() { this.wantSingle = 'maybe'; return this.execute(); }
  single() { this.wantSingle = 'strict'; return this.execute(); }
  then(resolve: (value: { data: unknown; error: unknown }) => unknown, reject?: (reason: unknown) => unknown) {
    return this.execute().then(resolve, reject);
  }

  private buildWhere(params: unknown[]): string {
    if (!this.filters.length) return '';
    const clauses = this.filters.map(filter => {
      if (filter.kind === 'is' || filter.kind === 'not_is') {
        const negate = filter.kind === 'not_is' ? 'not ' : '';
        return `${negate}${quoteIdent(filter.column)} is ${filter.value === null ? 'null' : filter.value ? 'true' : 'false'}`;
      }
      if (filter.kind === 'in') {
        params.push(filter.value);
        return `${quoteIdent(filter.column)} = any($${params.length})`;
      }
      if (filter.kind === 'contains') {
        if (Array.isArray(filter.value)) {
          params.push(filter.value);
          return `${quoteIdent(filter.column)} @> $${params.length}`;
        }
        params.push(JSON.stringify(filter.value));
        return `${quoteIdent(filter.column)} @> $${params.length}::jsonb`;
      }
      const operator = { eq: '=', neq: '<>', gte: '>=', lte: '<=', gt: '>', lt: '<' }[filter.kind];
      params.push(filter.value);
      return `${quoteIdent(filter.column)} ${operator} $${params.length}`;
    });
    return ' where ' + clauses.join(' and ');
  }

  private async execute(): Promise<{ data: unknown; error: unknown; count?: number }> {
    try {
      if (this.mode === 'insert') {
        const rows = Array.isArray(this.payload) ? this.payload : [this.payload as Record<string, unknown>];
        const inserted: Record<string, unknown>[] = [];
        for (const row of rows) {
          const keys = Object.keys(row);
          const params = keys.map(key => (row as Record<string, unknown>)[key]);
          const placeholders = keys.map((_, i) => `$${i + 1}`).join(',');
          const sql = `insert into ${quoteIdent(this.table)} (${keys.map(quoteIdent).join(',')}) values (${placeholders}) returning ${this.columns === '*' ? '*' : this.columns}`;
          const result = await this.pg.query(sql, params);
          inserted.push(...(result.rows as Record<string, unknown>[]));
        }
        return this.shapeResult(inserted);
      }
      if (this.mode === 'upsert') {
        const row = this.payload as Record<string, unknown>;
        const keys = Object.keys(row);
        const params = keys.map(key => row[key]);
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(',');
        const updateSet = keys.filter(key => key !== this.conflictColumn).map(key => `${quoteIdent(key)} = excluded.${quoteIdent(key)}`).join(',');
        const sql = `insert into ${quoteIdent(this.table)} (${keys.map(quoteIdent).join(',')}) values (${placeholders}) on conflict (${quoteIdent(this.conflictColumn)}) do update set ${updateSet} returning ${this.columns === '*' ? '*' : this.columns}`;
        const result = await this.pg.query(sql, params);
        return this.shapeResult(result.rows as Record<string, unknown>[]);
      }
      if (this.mode === 'update') {
        const keys = Object.keys(this.payload as Record<string, unknown>);
        const params: unknown[] = keys.map(key => (this.payload as Record<string, unknown>)[key]);
        const setClause = keys.map((key, i) => `${quoteIdent(key)} = $${i + 1}`).join(',');
        const where = this.buildWhereWithOffset(params);
        const sql = `update ${quoteIdent(this.table)} set ${setClause}${where} returning ${this.columns === '*' ? '*' : this.columns}`;
        const result = await this.pg.query(sql, params);
        return this.shapeResult(result.rows as Record<string, unknown>[]);
      }
      if (this.mode === 'delete') {
        const params: unknown[] = [];
        const where = this.buildWhere(params);
        const sql = `delete from ${quoteIdent(this.table)}${where} returning ${this.columns === '*' ? '*' : this.columns}`;
        const result = await this.pg.query(sql, params);
        return this.shapeResult(result.rows as Record<string, unknown>[]);
      }
      const params: unknown[] = [];
      const where = this.buildWhere(params);
      const order = this.orderBy ? ` order by ${quoteIdent(this.orderBy.column)} ${this.orderBy.ascending ? 'asc' : 'desc'}` : '';
      const limit = this.limitN !== null ? ` limit ${this.limitN}` : '';
      const sql = `select ${this.columns} from ${quoteIdent(this.table)}${where}${order}${limit}`;
      const result = await this.pg.query(sql, params);
      return this.shapeResult(result.rows as Record<string, unknown>[]);
    } catch (error) {
      return { data: null, error };
    }
  }

  private buildWhereWithOffset(existingParams: unknown[]): string {
    if (!this.filters.length) return '';
    const clauses = this.filters.map(filter => {
      if (filter.kind === 'is' || filter.kind === 'not_is') {
        const negate = filter.kind === 'not_is' ? 'not ' : '';
        return `${negate}${quoteIdent(filter.column)} is ${filter.value === null ? 'null' : filter.value ? 'true' : 'false'}`;
      }
      if (filter.kind === 'in') {
        existingParams.push(filter.value);
        return `${quoteIdent(filter.column)} = any($${existingParams.length})`;
      }
      if (filter.kind === 'contains') {
        if (Array.isArray(filter.value)) {
          existingParams.push(filter.value);
          return `${quoteIdent(filter.column)} @> $${existingParams.length}`;
        }
        existingParams.push(JSON.stringify(filter.value));
        return `${quoteIdent(filter.column)} @> $${existingParams.length}::jsonb`;
      }
      const operator = { eq: '=', neq: '<>', gte: '>=', lte: '<=', gt: '>', lt: '<' }[filter.kind];
      existingParams.push(filter.value);
      return `${quoteIdent(filter.column)} ${operator} $${existingParams.length}`;
    });
    return ' where ' + clauses.join(' and ');
  }

  private shapeResult(rows: Record<string, unknown>[]): { data: unknown; error: unknown } {
    if (this.wantSingle === 'maybe') return { data: rows[0] ?? null, error: null };
    if (this.wantSingle === 'strict') {
      if (rows.length !== 1) return { data: null, error: { message: `Expected exactly 1 row, got ${rows.length}` } };
      return { data: rows[0], error: null };
    }
    return { data: rows, error: null };
  }
}

/** Wraps a PGlite connection as a `DatabaseClient` (the `@supabase/postgrest-js`
 * subset the backend depends on) so real service code runs unmodified against
 * a real Postgres schema built from the actual migration files. */
export function pgliteDatabaseClient(pg: PGlite): DatabaseClient {
  return {
    from(table: string) { return new PgliteQueryBuilder(pg, table); },
    async rpc(name: string, args?: Record<string, unknown>) {
      const keys = Object.keys(args ?? {});
      const params = keys.map(key => (args as Record<string, unknown>)[key]);
      const callArgs = keys.map((key, i) => `${key.startsWith('p_') ? key : 'p_' + key} := $${i + 1}`).join(',');
      try {
        const result = await pg.query(`select ${name}(${callArgs}) as result`, params);
        return { data: (result.rows[0] as { result: unknown } | undefined)?.result ?? null, error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
  } as unknown as DatabaseClient;
}
