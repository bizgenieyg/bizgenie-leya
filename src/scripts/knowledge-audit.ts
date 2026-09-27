import { resolveTenant } from '../evals/dialog-eval.js';
import { runAudit } from '../services/knowledge-audit.service.js';

const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
/** npm run knowledge:audit -- --tenant=<uuid|prefix>: audit of all active facts, new cards in the cabinet. */
async function main() {
  const { supabase } = await import('../db/supabase.js');
  const { modelKeyConfigured } = await import('../providers/ai/index.js');
  if (!modelKeyConfigured()) throw new Error('GEMINI_API_KEY is not configured');
  const input = arg('tenant'); if (!input) throw new Error('--tenant=<uuid or unique prefix> is required');
  const tenants = await supabase.from('tenants').select('id,name'); if (tenants.error) throw new Error('Tenant lookup failed');
  const tenant = resolveTenant(input, (tenants.data ?? []) as Array<{ id: string; name: string | null }>);
  const result = await runAudit(supabase, tenant);
  console.log(`Candidates: ${result.candidates}; new cards: ${result.created}`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'knowledge:audit failed'); process.exitCode = 1; });
