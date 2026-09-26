import { readFileSync } from 'node:fs';
import { formatReport, loadScenarios, resolveTenant, runDialogEval, scriptedModel } from '../evals/dialog-eval.js';
import { EVAL_PRICE_INPUT_PER_MILLION, EVAL_PRICE_OUTPUT_PER_MILLION } from '../config/evals.js';

const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const live = process.argv.includes('--live');
const runs = Math.max(1, Number(arg('runs') ?? 1));
const file = arg('file') ?? 'evals/dialogs.yaml';

/**
 * npm run eval:dialogs -- [--live --tenant=<uuid|prefix>] [--runs=3]
 * Without --live: the scenarios run on a stand-in model in a throwaway PGlite database (no cost,
 * no production data). With --live: the real model on the given tenant, temporary simulator sessions.
 */
async function main() {
  const scenarios = loadScenarios(readFileSync(file, 'utf8'));
  let summary;
  if (live) {
    const { supabase } = await import('../db/supabase.js');
    const { createAIProvider, modelKeyConfigured } = await import('../providers/ai/index.js');
    if (!modelKeyConfigured()) throw new Error('GEMINI_API_KEY is not configured: --live needs the real model');
    const input = arg('tenant');
    if (!input) throw new Error('--live needs --tenant=<uuid or unique prefix>');
    const tenants = await supabase.from('tenants').select('id,name');
    if (tenants.error) throw new Error('Tenant lookup failed');
    const tenant = resolveTenant(input, (tenants.data ?? []) as Array<{ id: string; name: string | null }>);
    console.log(`Live run on tenant ${tenant}, ${runs} run(s)`);
    summary = await runDialogEval(supabase, tenant, scenarios, createAIProvider(), runs, line => console.log(line));
  } else {
    const { createTestDatabase, pgliteDatabaseClient } = await import('../services/test-support/pglite-harness.js');
    const pg = await createTestDatabase();
    const db = pgliteDatabaseClient(pg);
    const tenant = ((await db.from('tenants').insert({ name: 'Юрия', business_name: 'BizGenie', language: 'ru', tier: 'basic', status: 'active', business_sector: 'автоматизация' }).select('id').single()).data as { id: string }).id;
    await pg.query("insert into notification_settings(tenant_id,owner_phone,owner_chat_id,mode,time_zone,auto_replies_paused) values($1,'972500000002','972500000002@c.us','mute_all','Asia/Jerusalem',false)", [tenant]);
    await pg.query("insert into plans(code,display_name,messages_per_month,voice_minutes_per_month,warning_percent,unlimited) values('basic','Базовый',500,60,80,false) on conflict(code) do nothing");
    await pg.query("insert into tenant_usage_limits(tenant_id,plan,messages_per_month,voice_minutes_per_month,warning_percent,messages_overridden,voice_overridden,warning_overridden) values($1,'basic',500,60,80,false,false,false)", [tenant]);
    await pg.query("insert into assistant_profiles(tenant_id,assistant_name,allowed_languages,tone) values($1,'Лея',array['ru','he','en'],'friendly_professional')", [tenant]);
    await pg.query("insert into knowledge_items(tenant_id,type,question,answer,active) values($1,'faq','Сколько стоит подключение?','Подключение 1500 ₪.',true)", [tenant]);
    console.log('Offline run on a stand-in model (add --live --tenant=… for the real model)');
    summary = await runDialogEval(db, tenant, scenarios, scriptedModel(), runs, line => console.log(line));
    await pg.close();
  }
  console.log('\n' + formatReport(summary, { inputPerMillion: EVAL_PRICE_INPUT_PER_MILLION, outputPerMillion: EVAL_PRICE_OUTPUT_PER_MILLION }));
  process.exit(summary.routePass === summary.routeTotal && summary.textPass >= 0.9 * summary.textTotal ? 0 : 1);
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'eval failed'); process.exit(2); });
