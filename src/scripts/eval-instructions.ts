import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { emptyStats, formatInstructionReport, loadEvalFacts, loadInstructionScenarios, measured, runScenario, tenantScenarios, type ModelStats, type ScenarioRun } from '../evals/instruction-eval.js';
import { isKnowledgeTopic } from '../config/knowledge-topics.js';
import { EVAL_JUDGE_MODEL } from '../config/behavior.js';
import type { TemplateKey } from '../config/instruction-templates.js';
import { failureReason } from '../providers/ai/ai-provider.interface.js';

/** A tenant's own instruction file, or its template (evals/instructions/templates/<key>.md). */
const instructionPath = (spec: { instruction?: string; template?: string }) => spec.template ? `${DIR}/templates/${spec.template}.md` : `${DIR}/${spec.instruction}`;
const instructionLabel = (spec: { instruction?: string; template?: string }) => spec.template ? `template ${spec.template}` : 'instruction';
const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const DIR = 'evals/instructions';
/** Tenant fixtures on PGlite (no production data): who the owner is, the instruction, where the facts come from. */
export const TENANTS: Record<string, { owner: string; business: string; sector: string; facts: { kind: 'markdown' | 'extract'; file: string; saved?: string } }> = {
  bizgenie: { owner: 'Юрий', business: 'BizGenie', sector: 'автоматизация бизнеса', facts: { kind: 'markdown', file: 'bizgenie-facts.md' } },
  // Facts extracted once from ira-facts.md and kept (--extract-facts=ira rewrites them when the source changes).
  ira: { owner: 'Ирена', business: 'Ирена Прасолов', sector: 'эстетическая косметология', facts: { kind: 'extract', file: 'ira-facts.md', saved: 'ira-facts-extracted.md' } },
  // Z6: no own instruction — the template is resolved from the sector, like a newly registered business.
  manicure: { owner: 'Ольга', business: 'Ноготки', sector: 'мастер маникюра', facts: { kind: 'markdown', file: 'manicure-facts.md' } },
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
 * npm run eval:instructions -- --tenant=bizgenie|ira|all --model=<id>[,<id>] [--runs=3] [--facts-model=<id>] [--failures-only] [--judge-model=<id>] [--calibrate-judge=<id>] [--extract-facts=<tenant,…>] [--assistant-name=<имя>] [--out=docs/evals/…md]
 * Model ids: gemini-… / claude-… / gpt-… (provider by prefix; ANTHROPIC_API_KEY / OPENAI_API_KEY for the latter two).
 * npm run eval:instructions -- --check   (no model: validates the scenarios and fixtures)
 */
async function main() {
  const file = loadInstructionScenarios(readFileSync(`${DIR}/scenarios.yaml`, 'utf8'));
  // Z8: the assistant name the owner set (empty in the cabinet → «Лея» in the core).
  const assistantName = arg('assistant-name') ?? 'Лея';
  const tenants = (arg('tenant') ?? 'all') === 'all' ? Object.keys(TENANTS) : [arg('tenant')!];
  if (process.argv.includes('--check')) {
    for (const t of tenants) {
      const spec = TENANTS[t]; if (!spec) throw new Error(`Unknown tenant ${t}`);
      const scenarios = tenantScenarios(file, t, spec.owner, assistantName);
      const unfilled = scenarios.flatMap(s => s.turns).filter(turn => /\{[a-z_0-9]+\}/.test(turn));
      console.log(`${t}: ${scenarios.length} scenarios, ${instructionLabel(file.tenants[t]!)} ${readFileSync(instructionPath(file.tenants[t]!), 'utf8').length} chars${unfilled.length ? `, UNFILLED: ${unfilled.join(' | ')}` : ''}`);
      if (unfilled.length) process.exitCode = 1;
    }
    return;
  }
  const { createModelProvider, createTaskAIProvider, modelKeyConfigured } = await import('../providers/ai/index.js');
  if (!modelKeyConfigured()) throw new Error('GEMINI_API_KEY is not configured: eval:instructions needs the real model');
  const models = (arg('model') ?? process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite').split(',').map(m => m.trim()).filter(Boolean);
  // CLAUDE.md «Платный eval»: one run by default; --runs=3 before a rollout or on the owner's request.
  const runs = Math.max(1, Number(arg('runs') ?? 1));
  const { createTestDatabase, pgliteDatabaseClient } = await import('../services/test-support/pglite-harness.js');
  const { saveRuntimeSettings } = await import('../services/runtime-settings.service.js');
  const { uploadInstruction, activateInstruction } = await import('../services/instructions.service.js');
  const { extractFacts } = await import('../services/fact-extraction.service.js');
  // Z4: the judge is pinned (--judge-model, default EVAL_JUDGE_MODEL), not whatever GEMINI_TASK_MODEL says.
  const judgeModel = arg('judge-model') ?? EVAL_JUDGE_MODEL;
  const judgeAI = createTaskAIProvider(undefined, judgeModel);
  const calibrationModel = arg('calibrate-judge');
  const calibrationAI = calibrationModel ? createTaskAIProvider(undefined, calibrationModel) : null;
  console.log(`judge: ${judgeModel}${calibrationModel ? `, calibrating ${calibrationModel}` : ''}`);
  const results: Array<{ model: string; runs: ScenarioRun[]; stats: ModelStats }> = [];
  // Facts do not depend on the reply model: extracted once per tenant, before the models. A failed call is
  // retried with smaller chunks (a long chunk can run the task model out of output tokens).
  // --facts-model: the extraction model, when the task model cannot extract this fixture (reported).
  const factsAI = arg('facts-model') ? createTaskAIProvider(undefined, arg('facts-model')) : createTaskAIProvider();
  const factsByTenant = new Map<string, Array<{ topic: string; text: string }>>();
  for (const t of tenants) {
    const facts = await loadEvalFacts(t, TENANTS[t]!.facts, { dir: DIR, extractNow: (arg('extract-facts') ?? '').split(',').includes(t), ai: factsAI,
      extract: (ai, source, chunk, title) => extractFacts(ai, source, [], chunk, title), modelLabel: arg('facts-model') ?? (process.env.GEMINI_TASK_MODEL || 'default task model'), isTopic: isKnowledgeTopic });
    factsByTenant.set(t, facts);
  }
  for (const model of models) {
    const stats = emptyStats();
    const ai = measured(createModelProvider(model), stats, model);
    const all: ScenarioRun[] = [];
    for (const t of tenants) {
      const spec = TENANTS[t]!;
      const pg = await createTestDatabase(), db = pgliteDatabaseClient(pg);
      const tenantId = ((await db.from('tenants').insert({ name: spec.owner, business_name: spec.business, language: 'ru', tier: 'basic', status: 'active', business_sector: spec.sector }).select('id').single()).data as { id: string }).id;
      await pg.query("insert into notification_settings(tenant_id,owner_phone,owner_chat_id,mode,time_zone,auto_replies_paused) values($1,'972500000002','972500000002@c.us','mute_all','Asia/Jerusalem',false)", [tenantId]);
      await pg.query("insert into plans(code,display_name,messages_per_month,voice_minutes_per_month,warning_percent,unlimited) values('basic','Базовый',500,60,80,true) on conflict(code) do nothing");
      await pg.query("insert into tenant_usage_limits(tenant_id,plan,messages_per_month,voice_minutes_per_month,warning_percent,messages_overridden,voice_overridden,warning_overridden) values($1,'basic',100000,60,80,true,false,false)", [tenantId]);
      await pg.query("insert into assistant_profiles(tenant_id,assistant_name,allowed_languages,tone) values($1,$2,array['ru','he','en'],'friendly_professional')", [tenantId, assistantName]);
      // The model under test is the measured one (reply_model '' → the injected model), no fallback.
      await saveRuntimeSettings(db, tenantId, { reply_engine: 'instruction', reply_model: '', reply_fallback_model: '' });
      const tenantSpec = file.tenants[t]!;
      if (tenantSpec.template) {
        // Published like the operator does (instructions:publish --template); the tenant has none of its own.
        const target = { kind: 'template' as const, templateKey: tenantSpec.template as TemplateKey };
        await uploadInstruction(db, target, readFileSync(instructionPath(tenantSpec), 'utf8'));
        await activateInstruction(db, target, 1);
      } else {
        await uploadInstruction(db, { kind: 'business', tenantId }, readFileSync(instructionPath(tenantSpec), 'utf8'));
        await activateInstruction(db, { kind: 'business', tenantId }, 1);
      }
      const facts = factsByTenant.get(t)!;
      for (const fact of facts) await pg.query("insert into business_facts(tenant_id,topic,text,status,created_by) values($1,$2,$3,'active','migration')", [tenantId, fact.topic, fact.text]);
      console.log(`${model} · ${t}: ${facts.length} facts`);
      for (let run = 1; run <= runs; run++) for (const scenario of tenantScenarios(file, t, spec.owner, assistantName)) {
        const result = await runScenario(db, tenantId, scenario, run, ai, judgeAI, calibrationAI);
        all.push(result);
        console.log(`${model} · ${scenario.id} · ${run}: ${result.code.every(c => c.pass) && result.judge.every(c => c.pass) ? 'PASS' : 'FAIL'}`);
      }
      await pg.close();
    }
    results.push({ model, runs: all, stats });
  }
  const out = arg('out') ?? `docs/evals/${new Date().toISOString().slice(0, 10)}-instructions.md`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, formatInstructionReport(`eval:instructions — ${tenants.join(', ')}, ${runs} прогона`, results, { failuresOnly: process.argv.includes('--failures-only') }));
  console.log(`Report: ${out}`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'eval:instructions failed'); process.exitCode = 1; });
