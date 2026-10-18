import { createHash } from 'node:crypto';

/**
 * Task Z3: publishing a business or demo instruction through the operator API (ADMIN_SECRET), never direct SQL.
 * Upload a draft, activate it, optionally switch reply_engine / reply_model; the same text twice is not a new
 * version. The API is an interface so the logic is tested on PGlite with the real services behind it.
 */
export type PublishTarget = { tenantId: string; demoKey?: undefined; templateKey?: undefined } | { demoKey: string; tenantId?: undefined; templateKey?: undefined } | { templateKey: string; tenantId?: undefined; demoKey?: undefined };
export interface InstructionRow { version: number; status: string; sha256: string }
export interface OperatorApi {
  list(target: PublishTarget): Promise<InstructionRow[]>;
  upload(target: PublishTarget, content: string): Promise<{ version: number }>;
  activate(target: PublishTarget, version: number): Promise<void>;
  settings(tenantId: string): Promise<Record<string, unknown>>;
  saveSettings(tenantId: string, patch: Record<string, unknown>): Promise<void>;
}
export interface PublishOptions { target: PublishTarget; content: string; engine?: 'instruction' | 'legacy'; replyModel?: string; fallbackModel?: string; dryRun?: boolean;
  /** Provider keys present in the server env (Z5): a model whose provider has no key is refused before any change. */
  keys?: ProviderKeys }
export interface ProviderKeys { gemini: boolean; anthropic: boolean; openai: boolean }
const PROVIDERS: Array<{ prefix: string; key: keyof ProviderKeys; env: string }> = [
  { prefix: 'gemini-', key: 'gemini', env: 'GEMINI_API_KEY' }, { prefix: 'claude-', key: 'anthropic', env: 'ANTHROPIC_API_KEY' }, { prefix: 'gpt-', key: 'openai', env: 'OPENAI_API_KEY' },
];
/** Z5: a reply/fallback model id must name a known provider whose key the server has; '' (clear) is always fine. */
export function checkModel(flag: string, model: string, keys: ProviderKeys | undefined): void {
  if (!model) return;
  if (!/^[a-z0-9._-]{1,80}$/i.test(model)) throw new Error(`${flag}: invalid model id`);
  const provider = PROVIDERS.find(p => model.startsWith(p.prefix));
  if (!provider) throw new Error(`${flag}: unknown model prefix (expected ${PROVIDERS.map(p => p.prefix).join(' / ')})`);
  if (keys && !keys[provider.key]) throw new Error(`${flag}: ${provider.env} is not set in the server env`);
}
export type Step = { action: 'upload' } | { action: 'activate'; version: number | 'new' } | { action: 'unchanged'; version: number } | { action: 'settings'; patch: Record<string, unknown> };

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** What publishing would do (also the --dry-run output). */
export async function publishPlan(api: OperatorApi, options: PublishOptions): Promise<Step[]> {
  if (options.replyModel !== undefined) checkModel('--reply-model', options.replyModel, options.keys);
  if (options.fallbackModel !== undefined) checkModel('--fallback-model', options.fallbackModel, options.keys);
  const rows = await api.list(options.target), hash = sha256(options.content);
  const same = rows.filter(r => r.sha256 === hash).sort((a, b) => b.version - a.version)[0];
  const steps: Step[] = same ? (same.status === 'active' ? [{ action: 'unchanged', version: same.version }] : [{ action: 'activate', version: same.version }])
    : [{ action: 'upload' }, { action: 'activate', version: 'new' }];
  if (options.target.tenantId) {
    const current = await api.settings(options.target.tenantId), patch: Record<string, unknown> = {};
    if (options.engine && current.reply_engine !== options.engine) patch.reply_engine = options.engine;
    if (options.replyModel !== undefined && current.reply_model !== options.replyModel) patch.reply_model = options.replyModel;
    if (options.fallbackModel !== undefined && current.reply_fallback_model !== options.fallbackModel) patch.reply_fallback_model = options.fallbackModel;
    if (Object.keys(patch).length) steps.push({ action: 'settings', patch });
  } else if (options.engine || options.replyModel !== undefined || options.fallbackModel !== undefined) throw new Error('--engine, --reply-model and --fallback-model apply to a tenant, not to a demo or a template');
  return steps;
}

export async function publishInstruction(api: OperatorApi, options: PublishOptions): Promise<Step[]> {
  if (!options.content.trim()) throw new Error('Empty instruction file');
  const steps = await publishPlan(api, options);
  if (options.dryRun) return steps;
  let uploaded: number | null = null;
  for (const step of steps) {
    if (step.action === 'upload') uploaded = (await api.upload(options.target, options.content)).version;
    else if (step.action === 'activate') await api.activate(options.target, step.version === 'new' ? uploaded! : step.version);
    else if (step.action === 'settings') await api.saveSettings(options.target.tenantId!, step.patch);
  }
  return steps;
}

/** Rollback: the tenant answers by the legacy path again; instruction versions, reply_model and
 *  reply_fallback_model stay as they are (Z5). */
export async function rollbackInstruction(api: OperatorApi, tenantId: string, dryRun = false): Promise<Step[]> {
  const current = await api.settings(tenantId);
  const steps: Step[] = current.reply_engine === 'legacy' ? [] : [{ action: 'settings', patch: { reply_engine: 'legacy' } }];
  if (!dryRun) for (const step of steps) if (step.action === 'settings') await api.saveSettings(tenantId, step.patch);
  return steps;
}

export function describeSteps(steps: Step[]): string[] {
  if (!steps.length) return ['Ничего менять не нужно.'];
  return steps.map(s => s.action === 'upload' ? 'Загрузить новую версию (draft)'
    : s.action === 'activate' ? `Активировать версию ${s.version === 'new' ? 'новую' : s.version}`
    : s.action === 'unchanged' ? `Текст уже опубликован: версия ${s.version} активна — новая версия не создаётся`
    : `Настройки: ${Object.entries(s.patch).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`);
}
