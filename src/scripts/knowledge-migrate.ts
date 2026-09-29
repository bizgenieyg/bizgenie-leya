import { resolveTenant } from '../evals/dialog-eval.js';
import { formatMigration, migrateKnowledge } from '../services/knowledge-migration.service.js';

const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
/** npm run knowledge:migrate -- --tenant=<uuid|prefix> [--dry-run] */
async function main() {
  const { supabase } = await import('../db/supabase.js');
  const { createTaskAIProvider, modelKeyConfigured } = await import('../providers/ai/index.js');
  const { createEmbeddingProvider } = await import('../providers/embedding/index.js');
  if (!modelKeyConfigured()) throw new Error('GEMINI_API_KEY is not configured');
  const input = arg('tenant'); if (!input) throw new Error('--tenant=<uuid or unique prefix> is required');
  const tenants = await supabase.from('tenants').select('id,name'); if (tenants.error) throw new Error('Tenant lookup failed');
  const tenant = resolveTenant(input, (tenants.data ?? []) as Array<{ id: string; name: string | null }>);
  const dryRun = process.argv.includes('--dry-run');
  const result = await migrateKnowledge(supabase, tenant, createTaskAIProvider(), createEmbeddingProvider(), dryRun);
  console.log(formatMigration(result));
  console.log(dryRun ? 'Dry run: nothing written.' : `Saved ${result.saved} active facts; knowledge_mode=${result.saved ? 'facts' : 'unchanged'}.`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'knowledge:migrate failed'); process.exitCode = 1; });
