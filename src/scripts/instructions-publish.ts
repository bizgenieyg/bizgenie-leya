import { readFileSync } from 'node:fs';
import { describeSteps, publishInstruction, rollbackInstruction, type OperatorApi, type PublishTarget } from '../services/instruction-publish.js';
import { env } from '../config/env.js';

const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name: string) => process.argv.includes(`--${name}`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The operator API of the running leya-api (ADMIN_SECRET as Bearer). */
function httpApi(base: string, secret: string): OperatorApi {
  const call = async (path: string, query: Record<string, string>, init: RequestInit = {}) => {
    const url = new URL(`/api/admin${path}`, base);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${secret}`, ...(init.headers ?? {}) }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  const q = (t: PublishTarget): Record<string, string> => t.tenantId ? { tenantId: t.tenantId } : { demoKey: t.demoKey! };
  return {
    list: t => call('/instructions', q(t)),
    upload: (t, content) => call('/instructions', q(t), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: content }),
    activate: async (t, version) => { await call('/instructions/activate', q(t), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version }) }); },
    settings: tenantId => call('/tenant-settings', { tenantId }),
    saveSettings: async (tenantId, patch) => { await call('/tenant-settings', { tenantId }, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }); },
  };
}

/**
 * npm run instructions:publish -- --tenant=<uuid> --file=<md> [--engine=instruction|legacy] [--reply-model=<id>] [--dry-run]
 * npm run instructions:publish -- --demo=home_cook|cosmetologist --file=<md> [--dry-run]
 * npm run instructions:publish -- --rollback --tenant=<uuid> [--dry-run]
 * [--api=http://127.0.0.1:<PORT>] — the leya-api base URL; ADMIN_SECRET from the environment.
 */
async function main() {
  const secret = env.adminSecret, api = httpApi(arg('api') ?? `http://127.0.0.1:${env.port}`, secret ?? '');
  if (!secret) throw new Error('ADMIN_SECRET is not configured');
  const tenant = arg('tenant'), demo = arg('demo'), dryRun = flag('dry-run');
  if (tenant && !UUID.test(tenant)) throw new Error('--tenant must be a UUID');
  if (flag('rollback')) {
    if (!tenant) throw new Error('--rollback needs --tenant');
    const steps = await rollbackInstruction(api, tenant, dryRun);
    console.log([dryRun ? 'План (dry-run):' : 'Сделано:', ...describeSteps(steps)].join('\n'));
    return;
  }
  if (!!tenant === !!demo) throw new Error('Give exactly one of --tenant or --demo');
  if (demo && !/^[a-z][a-z0-9_]{1,39}$/.test(demo)) throw new Error('--demo must be a demo key like home_cook');
  const file = arg('file'); if (!file) throw new Error('--file=<path> is required');
  const engine = arg('engine');
  if (engine !== undefined && engine !== 'instruction' && engine !== 'legacy') throw new Error('--engine must be instruction or legacy');
  const steps = await publishInstruction(api, { target: tenant ? { tenantId: tenant } : { demoKey: demo! }, content: readFileSync(file, 'utf8'),
    ...(engine ? { engine } : {}), ...(arg('reply-model') !== undefined ? { replyModel: arg('reply-model')! } : {}), dryRun });
  console.log([dryRun ? 'План (dry-run):' : 'Сделано:', ...describeSteps(steps)].join('\n'));
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'instructions:publish failed'); process.exitCode = 1; });
