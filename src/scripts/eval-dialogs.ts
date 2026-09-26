import { readFileSync } from 'node:fs';
import { supabase } from '../db/supabase.js';
import { createAIProvider } from '../providers/ai/index.js';
import { formatReport, loadScenarios, runDialogEval } from '../evals/dialog-eval.js';
import { EVAL_PRICE_INPUT_PER_MILLION, EVAL_PRICE_OUTPUT_PER_MILLION } from '../config/evals.js';

const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const tenant = arg('tenant'), runs = Number(arg('runs') ?? 1), file = arg('file') ?? 'evals/dialogs.yaml';
if (!tenant || !/^[0-9a-f-]{36}$/i.test(tenant)) { console.error('Usage: npm run eval:dialogs -- --tenant=<uuid> [--runs=3]'); process.exit(2); }
const provider = createAIProvider();
if (!provider) { console.error('GEMINI_API_KEY is not configured: evaluations need the real model'); process.exit(2); }
async function main() {
const summary = await runDialogEval(supabase, tenant!, loadScenarios(readFileSync(file, 'utf8')), provider!, Math.max(1, runs), line => console.log(line));
console.log('\n' + formatReport(summary, { inputPerMillion: EVAL_PRICE_INPUT_PER_MILLION, outputPerMillion: EVAL_PRICE_OUTPUT_PER_MILLION }));
process.exit(summary.routePass === summary.routeTotal && summary.textPass >= 0.9 * summary.textTotal ? 0 : 1);
}
void main().catch(error => { console.error('eval_failed', error instanceof Error ? error.message : 'unknown'); process.exit(2); });
