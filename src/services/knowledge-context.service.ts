import type { DatabaseClient } from '../db/supabase.js';
import type { TenantContext } from './context.service.js';
import { findSemanticKnowledge } from './semantic-knowledge.service.js';
import { behavior } from './runtime-settings.service.js';
import type { OwnerSettings } from './owner-settings.service.js';

export type KnowledgeMode = 'full' | 'search';
export interface KnowledgeMaterials { materials: NonNullable<TenantContext['materials']>; mode: KnowledgeMode; chars: number }

/**
 * Small knowledge bases go to the model whole: embedding similarity cannot tell relevant from
 * irrelevant units reliably, so no threshold filtering. Large bases fall back to unit search.
 * Shared by WhatsApp and the simulator.
 */
export async function loadKnowledgeMaterials(db: DatabaseClient, tenantId: string, query: string, context: TenantContext,
  settings: OwnerSettings, search: typeof findSemanticKnowledge = findSemanticKnowledge): Promise<KnowledgeMaterials> {
  const config = behavior(settings);
  const documents = await db.from('knowledge_documents').select('file_name,extracted_text').eq('tenant_id', tenantId).eq('status', 'ready');
  if (documents.error) throw new Error('Knowledge documents unavailable');
  const docs = (documents.data ?? []).filter(row => typeof row.extracted_text === 'string' && row.extracted_text.trim());
  const faqChars = context.knowledge.reduce((n, item) => n + (item.question?.length ?? 0) + item.answer.length, 0);
  const docChars = docs.reduce((n, row) => n + String(row.extracted_text).length, 0);
  if (faqChars + docChars <= config.knowledge_full_context_chars)
    return { mode: 'full', chars: faqChars + docChars,
      materials: docs.map(row => ({ file_name: String(row.file_name), content: String(row.extracted_text), similarity: 1 })) };
  const materials = docs.length ? await search(db, tenantId, query) : [];
  return { mode: 'search', materials, chars: faqChars + materials.reduce((n, item) => n + item.content.length, 0) };
}
