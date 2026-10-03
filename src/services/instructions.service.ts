import { createHash } from 'node:crypto';
import type { DatabaseClient } from '../db/supabase.js';
import { HttpError } from '../utils/http-error.js';
import { CORE_INSTRUCTION_DEFAULT, DEMO_INSTRUCTION_DEFAULTS } from '../config/instruction-defaults.js';
import { CORE_CONFIG_KEY, INSTRUCTION_PLACEHOLDERS } from '../config/instructions.js';

/** Task Z: core of the platform (config default, operator override) + versioned business and demo instructions. */
const check = (error: unknown, message: string) => { if (error) throw new Error(message); };
export const MAX_INSTRUCTION_CHARS = 50_000;

export async function loadCore(db: DatabaseClient): Promise<string> {
  const r = await db.from('system_config').select('value').eq('key', CORE_CONFIG_KEY).maybeSingle();
  if (r.error) return CORE_INSTRUCTION_DEFAULT;
  const value = r.data?.value;
  return typeof value === 'string' && value.trim() ? value : CORE_INSTRUCTION_DEFAULT;
}
export async function activeBusinessInstruction(db: DatabaseClient, tenantId: string): Promise<string | null> {
  const r = await db.from('assistant_instructions').select('content').eq('tenant_id', tenantId).eq('kind', 'business').eq('status', 'active').maybeSingle();
  check(r.error, 'Instruction unavailable');
  return typeof r.data?.content === 'string' ? r.data.content : null;
}
/** Active demo text; the built-in one when the operator has not loaded any. */
export async function activeDemoInstruction(db: DatabaseClient, demoKey: string): Promise<string | null> {
  const r = await db.from('assistant_instructions').select('content').eq('kind', 'demo').eq('demo_key', demoKey).eq('status', 'active').maybeSingle();
  check(r.error, 'Demo instruction unavailable');
  return typeof r.data?.content === 'string' ? r.data.content : DEMO_INSTRUCTION_DEFAULTS[demoKey] ?? null;
}

/**
 * {business_name}, {owner_name}. A known placeholder with no value makes the whole text unusable (null):
 * the caller does not reply and logs only the placeholder name.
 */
export function fillPlaceholders(text: string, values: Partial<Record<(typeof INSTRUCTION_PLACEHOLDERS)[number], string | null | undefined>>): { text: string | null; missing: string[] } {
  const missing: string[] = [];
  const filled = text.replace(/\{([a-z_]+)\}/g, (all, key: string) => {
    if (!(INSTRUCTION_PLACEHOLDERS as readonly string[]).includes(key)) return all;
    const value = values[key as (typeof INSTRUCTION_PLACEHOLDERS)[number]]?.trim();
    if (!value) { missing.push(key); return all; }
    return value;
  });
  return { text: missing.length ? null : filled, missing: [...new Set(missing)] };
}

type Target = { kind: 'business'; tenantId: string } | { kind: 'demo'; demoKey: string };
const scope = (db: DatabaseClient, target: Target) => {
  const q = db.from('assistant_instructions').select('id,kind,demo_key,version,status,created_by,created_at,content').eq('kind', target.kind);
  return target.kind === 'business' ? q.eq('tenant_id', target.tenantId) : q.eq('demo_key', target.demoKey);
};
export function instructionTarget(input: { tenantId?: unknown; demoKey?: unknown }): Target {
  if (typeof input.demoKey === 'string' && /^[a-z][a-z0-9_]{1,39}$/.test(input.demoKey)) return { kind: 'demo', demoKey: input.demoKey };
  if (typeof input.tenantId === 'string' && input.tenantId) return { kind: 'business', tenantId: input.tenantId };
  throw new HttpError(400, 'tenantId or demoKey required', { code: 'instruction_target' });
}

/** Operator: a new draft version (next number). */
export async function uploadInstruction(db: DatabaseClient, target: Target, content: unknown, createdBy = 'operator') {
  if (typeof content !== 'string' || !content.trim() || content.length > MAX_INSTRUCTION_CHARS) throw new HttpError(400, 'Invalid instruction', { code: 'instruction_invalid' });
  const last = await scope(db, target).order('version', { ascending: false }).limit(1);
  check(last.error, 'Instructions unavailable');
  const version = Number(last.data?.[0]?.version ?? 0) + 1;
  const inserted = await db.from('assistant_instructions').insert({ kind: target.kind, ...(target.kind === 'business' ? { tenant_id: target.tenantId } : { demo_key: target.demoKey }),
    version, content, status: 'draft', created_by: createdBy }).select('id,version,status').single();
  check(inserted.error || !inserted.data, 'Instruction save failed');
  return inserted.data!;
}
/** Operator: make one version active; the previous active one is archived. */
export async function activateInstruction(db: DatabaseClient, target: Target, version: unknown) {
  if (!Number.isSafeInteger(version) || Number(version) < 1) throw new HttpError(400, 'Invalid version', { code: 'instruction_version' });
  const row = await scope(db, target).eq('version', Number(version)).maybeSingle();
  check(row.error, 'Instructions unavailable');
  if (!row.data) throw new HttpError(404, 'Version not found', { code: 'instruction_not_found' });
  const previous = await scope(db, target).eq('status', 'active');
  check(previous.error, 'Instructions unavailable');
  for (const p of previous.data ?? []) if (p.id !== row.data.id) check((await db.from('assistant_instructions').update({ status: 'archived' }).eq('id', p.id)).error, 'Instruction archive failed');
  check((await db.from('assistant_instructions').update({ status: 'active' }).eq('id', row.data.id)).error, 'Instruction activate failed');
  return { id: row.data.id, version: row.data.version, status: 'active' };
}
export async function listInstructions(db: DatabaseClient, target: Target) {
  const r = await scope(db, target).order('version', { ascending: false });
  check(r.error, 'Instructions unavailable');
  // Content stays on the server; the hash lets a publisher see that a text is already uploaded (Z3).
  return (r.data ?? []).map(({ content, ...row }) => ({ ...row, chars: String(content).length, sha256: createHash('sha256').update(String(content)).digest('hex') }));
}
