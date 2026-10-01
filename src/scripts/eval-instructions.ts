import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { formatInstructionReport, loadInstructionScenarios, measured, runScenario, tenantScenarios, type ModelStats, type ScenarioRun } from '../evals/instruction-eval.js';
import { EVAL_PRICE_INPUT_PER_MILLION, EVAL_PRICE_OUTPUT_PER_MILLION } from '../config/evals.js';
import { isKnowledgeTopic } from '../config/knowledge-topics.js';
import { failureReason } from '../providers/ai/ai-provider.interface.js';

const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const DIR = 'evals/instructions';
/** Tenant fixtures on PGlite (no production data): who the owner is, the instruction, where the facts come from. */
export const TENANTS: Record<string, { owner: string; business: string; sector: string; facts: { kind: 'markdown' | 'extract'; file: string } }> = {
  bizgenie: { owner: 'Юрий', business: 'BizGenie', sector: 'автоматизация бизнеса', facts: { kind: 'markdown', file: 'bizgenie-facts.md' } },
  ira: { owner: 'Ирена', business: 'Ирена Прасолов', sector: 'эстетическая косметология', facts: { kind: 'extract', file: 'ira-facts.md' } },
};
/** "## topic\n- fact" lines of an exported facts file. */
export function parseFactsMarkdown(markdown: string): Array<{ topic: string; text: string }> {
  let topic = 'other';
  return markdown.split('\n').flatMap(line => {
    const heading = /^##\s+([a-z_]+)\s*$/.exec(line.trim());
    if (heading) { topic = isKnowledgeTopic(heading[1]) ? heading[1]! : 'other'; return []; }
    const item = /^-\s+(.+)$/.exec(line.trim());
    return item ? [{ topic, text: item[1]!.slice(0, 500) }] : [];
  });
}

/**
 * npm run eval:instructions -- --tenant=bizgenie|ira|all --model=<id>[,<id>] [--runs=3] [--facts-model=<id>] [--out=docs/evals/…md]
 * npm run eval:instructions -- --check   (no model: validates the scenarios and fixtures)
 */
async function main() {
  const file = loadInstructionScenarios(readFileSync(`${DIR}/scenarios.yaml`, 'utf8'));
  const tenants = (arg('tenant') ?? 'all') === 'all' ? Object.keys(TENANTS) : [arg('tenant')!];
  if (process.argv.includes('--check')) {
    for (const t of tenants) {
      const spec = TENANTS[t]; if (!spec) throw new Error(`Unknown tenant ${t}`);
      const scenarios = tenantScenarios(file, t, spec.owner);
      const unfilled = scenarios.flatMap(s => s.turns).filter(turn => /\{[a-z_0-9]+\}/.test(turn));
      console.log(`${t}: ${scenarios.length} scenarios, instruction ${readFileSync(`${DIR}/${file.tenants[t]!.instruction}`, 'utf8').length} chars${unfilled.length ? `, UNFILLED: ${unfilled.join(' | ')}` : ''}`);
      if (unfilled.length) process.exitCode = 1;
    }
    return;
  }
  const { createAIProvider, createTaskAIProvider, modelKeyConfigured } = await import('../providers/ai/index.js');
  if (!modelKeyConfigured()) throw new Error('GEMINI_API_KEY is not configured: eval:instructions needs the real model');
  const models = (arg('model') ?? process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite').split(',').map(m => m.trim()).filter(Boolean);
  const runs = Math.max(1, Number(arg('runs') ?? 3));
  const { createTestDatabase, pgliteDatabaseClient } = await import('../services/test-support/pglite-harness.js');
  const { saveRuntimeSettings } = await import('../services/runtime-settings.service.js');
  const { uploadInstruction, activateInstruction } = await import('../services/instructions.service.js');
  const { extractFacts } = await import('../services/fact-extraction.service.js');
  const judgeAI = createTaskAIProvider();
  const results: Array<{ model: string; runs: ScenarioRun[]; stats: ModelStats; cost: number }> = [];
  // Facts do not depend on the reply model: extracted once per tenant, before the models. A failed call is
  // retried with smaller chunks (a long chunk can run the task model out of output tokens).
  // --facts-model: the extraction model, when the task model cannot extract this fixture (reported).
  const factsAI = arg('facts-model') ? createTaskAIProvider(undefined, arg('facts-model')) : judgeAI;
  const factsByTenant = new Map<string, Array<{ topic: string; text: string }>>();
  for (const t of tenants) {
    const spec = TENANTS[t]!, source = readFileSync(`${DIR}/${spec.facts.file}`, 'utf8');
    if (spec.facts.kind === 'markdown') { factsByTenant.set(t, parseFactsMarkdown(source)); continue; }
    let facts: Array<{ topic: string; text: string }> | null = null, reason = '';
    for (const chunk of [2500, 1200, 600]) {
      try { facts = (await extractFacts(factsAI, source, [], chunk, spec.facts.file)).facts; break; }
      catch (error) { reason = failureReason(error); console.warn(`${t}: facts extraction failed (${reason}), chunk ${chunk}`); }
    }
    if (!facts) throw new Error(`eval:instructions: facts extraction for ${t} failed (${reason}); model ${arg('facts-model') ?? (process.env.GEMINI_TASK_MODEL || 'default')}`);
    factsByTenant.set(t, facts);
    console.log(`${t}: ${facts.length} facts extracted by ${arg('facts-model') ?? (process.env.GEMINI_TASK_MODEL || 'default task model')}`);
  }
  for (const model of models) {
    const stats: ModelStats = { calls: 0, latencyMs: 0, input: 0, output: 0, thinking: 0 };
    const ai = measured(createAIProvider(undefined, model), stats);
    const all: ScenarioRun[] = [];
    for (const t of tenants) {
      const spec = TENANTS[t]!;
      const pg = await createTestDatabase(), db = pgliteDatabaseClient(pg);
      const tenantId = ((await db.from('tenants').insert({ name: spec.owner, business_name: spec.business, language: 'ru', tier: 'basic', status: 'active', business_sector: spec.sector }).select('id').single()).data as { id: string }).id;
      await pg.query("insert into notification_settings(tenant_id,owner_phone,owner_chat_id,mode,time_zone,auto_replies_paused) values($1,'972500000002','972500000002@c.us','mute_all','Asia/Jerusalem',false)", [tenantId]);
      await pg.query("insert into plans(code,display_name,messages_per_month,voice_minutes_per_month,warning_percent,unlimited) values('basic','Базовый',500,60,80,true) on conflict(code) do nothing");
      await pg.query("insert into tenant_usage_limits(tenant_id,plan,messages_per_month,voice_minutes_per_month,warning_percent,messages_overridden,voice_overridden,warning_overridden) values($1,'basic',100000,60,80,true,false,false)", [tenantId]);
      await pg.query("insert into assistant_profiles(tenant_id,assistant_name,allowed_languages,tone) values($1,'Лея',array['ru','he','en'],'friendly_professional')", [tenantId]);
      await saveRuntimeSettings(db, tenantId, { reply_engine: 'instruction' });
      await uploadInstruction(db, { kind: 'business', tenantId }, readFileSync(`${DIR}/${file.tenants[t]!.instruction}`, 'utf8'));
      await activateInstruction(db, { kind: 'business', tenantId }, 1);
      const facts = factsByTenant.get(t)!;
      for (const fact of facts) await pg.query("insert into business_facts(tenant_id,topic,text,status,created_by) values($1,$2,$3,'active','migration')", [tenantId, fact.topic, fact.text]);
      console.log(`${model} · ${t}: ${facts.length} facts`);
      for (let run = 1; run <= runs; run++) for (const scenario of tenantScenarios(file, t, spec.owner)) {
        const result = await runScenario(db, tenantId, scenario, run, ai, judgeAI);
        all.push(result);
        console.log(`${model} · ${scenario.id} · ${run}: ${result.code.every(c => c.pass) && result.judge.every(c => c.pass) ? 'PASS' : 'FAIL'}`);
      }
      await pg.close();
    }
    results.push({ model, runs: all, stats, cost: stats.input / 1e6 * EVAL_PRICE_INPUT_PER_MILLION + (stats.output + stats.thinking) / 1e6 * EVAL_PRICE_OUTPUT_PER_MILLION });
  }
  const out = arg('out') ?? `docs/evals/${new Date().toISOString().slice(0, 10)}-instructions.md`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, formatInstructionReport(`eval:instructions — ${tenants.join(', ')}, ${runs} прогона`, results));
  console.log(`Report: ${out}`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'eval:instructions failed'); process.exitCode = 1; });
