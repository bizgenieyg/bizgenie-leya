import type { DatabaseClient } from '../db/supabase.js';
import type { EmbeddingProvider } from '../providers/embedding/embedding-provider.interface.js';
import type { OwnerSettings } from './owner-settings.service.js';
import { behavior } from './runtime-settings.service.js';
import { factsForReply, vectorOf } from './business-facts.service.js';
import { recordUsageEvent } from './usage.service.js';

/** Examples in the prompt: the ones closest to the client's message. */
export const EXAMPLES_IN_PROMPT = 3;
const cosine = (a: number[], b: number[]) => { let d = 0, x = 0, y = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) { d += a[i]! * b[i]!; x += a[i]! ** 2; y += b[i]! ** 2; } return x && y ? d / Math.sqrt(x * y) : 0; };

export interface FactsContext { businessProfile: string; assistantRules: string[]; assistantExamples: Array<{ client: string; reply: string }>; chars: number; mode: 'facts_full' | 'facts_search' }

/**
 * Answer context in knowledge_mode='facts' (task R): the business profile (never raw source texts),
 * the owner's rules and up to three example replies nearest to the client's message.
 */
export async function loadFactsContext(db: DatabaseClient, tenantId: string, query: string, settings: OwnerSettings, embedder: EmbeddingProvider | null): Promise<FactsContext> {
  const config = behavior(settings);
  const profile = await factsForReply(db, tenantId, query, config.knowledge_full_context_chars, config.facts_search_results, embedder);
  const rules = await db.from('assistant_rules').select('text').eq('tenant_id', tenantId).eq('status', 'active').order('created_at', { ascending: true }).limit(20);
  if (rules.error) throw new Error('Assistant rules unavailable');
  const examples = await db.from('assistant_examples').select('client_text,reply_text,embedding,embedding_model,created_at').eq('tenant_id', tenantId).eq('status', 'active').order('created_at', { ascending: false }).limit(10);
  if (examples.error) throw new Error('Assistant examples unavailable');
  let chosen = (examples.data ?? []) as Array<{ client_text: string; reply_text: string; embedding?: unknown; embedding_model?: string | null }>;
  if (chosen.length > EXAMPLES_IN_PROMPT && embedder && chosen.every(e => vectorOf(e.embedding) && e.embedding_model === embedder.model)) {
    try {
      const embedded = await embedder.embed([query], 'RETRIEVAL_QUERY');
      await recordUsageEvent(db, { tenantId, eventType: 'embedding_call', quantity: embedded.inputTokens ?? Math.ceil(query.length / 4), metadata: { purpose: 'example_search', model: embedder.model, billable_message: false } });
      const q = embedded.vectors[0]!;
      chosen = [...chosen].sort((a, b) => cosine(q, vectorOf(b.embedding)!) - cosine(q, vectorOf(a.embedding)!));
    } catch { console.warn('example_search_failed', { tenantId }); }
  }
  const assistantExamples = chosen.slice(0, EXAMPLES_IN_PROMPT).map(e => ({ client: String(e.client_text), reply: String(e.reply_text) }));
  const assistantRules = (rules.data ?? []).map(r => String(r.text));
  return { businessProfile: profile.markdown, assistantRules, assistantExamples, chars: profile.chars, mode: profile.mode === 'full' ? 'facts_full' : 'facts_search' };
}
