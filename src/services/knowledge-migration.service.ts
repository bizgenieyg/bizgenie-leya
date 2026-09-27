import type { DatabaseClient } from '../db/supabase.js';
import type { AIProvider } from '../providers/ai/ai-provider.interface.js';
import type { EmbeddingProvider } from '../providers/embedding/embedding-provider.interface.js';
import { behavior, saveRuntimeSettings } from './runtime-settings.service.js';
import { loadOwnerSettings } from './owner-settings.service.js';
import { extractFacts, type Extraction } from './fact-extraction.service.js';
import { activeFacts, saveExtraction } from './business-facts.service.js';
import { meterAI } from './metered-providers.js';

/**
 * Current knowledge → business facts (task R, `npm run knowledge:migrate`). Q&A pairs and ready documents
 * become sources of kind 'migration' (documents by link, files and chunks untouched) and their facts are
 * active at once: the owner already approved this knowledge. Old tables stay; knowledge_mode='facts' is set
 * after a successful run and 'legacy' rolls it back. A dry run writes nothing.
 */
export interface MigrationPart { title: string; documentId: string | null; text: string; extraction: Extraction }
export async function migrateKnowledge(db: DatabaseClient, tenantId: string, ai: AIProvider, embedder: EmbeddingProvider | null, dryRun: boolean): Promise<{ parts: MigrationPart[]; saved: number }> {
  const config = behavior(await loadOwnerSettings(db, tenantId));
  const items = await db.from('knowledge_items').select('question,answer').eq('tenant_id', tenantId).eq('active', true);
  if (items.error) throw new Error('Knowledge items unavailable');
  const docs = await db.from('knowledge_documents').select('id,file_name,extracted_text').eq('tenant_id', tenantId).eq('status', 'ready');
  if (docs.error) throw new Error('Knowledge documents unavailable');
  const inputs: Array<{ title: string; documentId: string | null; text: string }> = [];
  const pairs = (items.data ?? []).map(i => `${i.question ? `Вопрос: ${i.question}\n` : ''}Ответ: ${i.answer}`).join('\n\n');
  if (pairs.trim()) inputs.push({ title: 'Вопросы и ответы', documentId: null, text: pairs });
  for (const d of docs.data ?? []) if (String(d.extracted_text ?? '').trim()) inputs.push({ title: String(d.file_name), documentId: String(d.id), text: String(d.extracted_text) });
  const metered = meterAI(db, tenantId, ai, { purpose: 'knowledge_migration', billable_message: false })!;
  const parts: MigrationPart[] = [];
  let saved = 0;
  for (const input of inputs) {
    const existing = dryRun ? parts.flatMap((p, i) => p.extraction.facts.map((f, j) => ({ id: `dry-${i}-${j}`, topic: f.topic, text: f.text })))
      : (await activeFacts(db, tenantId)).map(f => ({ id: f.id, topic: f.topic, text: f.text }));
    const extraction = await extractFacts(metered, input.text, existing, config.extraction_chunk_chars, input.title);
    parts.push({ ...input, extraction });
    if (dryRun) continue;
    const source = await db.from('knowledge_sources').insert({ tenant_id: tenantId, kind: 'migration', title: input.title.slice(0, 300), original_text: input.text.slice(0, 200_000), document_id: input.documentId, status: 'ready' }).select('id').single();
    if (source.error || !source.data) throw new Error('Knowledge source save failed');
    saved += (await saveExtraction(db, tenantId, String(source.data.id), extraction, { status: 'active', createdBy: 'migration', embedder, duplicateThreshold: config.fact_duplicate_threshold })).saved;
  }
  if (!dryRun && saved > 0) await saveRuntimeSettings(db, tenantId, { knowledge_mode: 'facts' });
  return { parts, saved };
}

export function formatMigration(parts: MigrationPart[]): string {
  const facts = parts.flatMap(p => p.extraction.facts);
  const topics = [...new Set(facts.map(f => f.topic))];
  const gaps = [...new Set(parts.flatMap(p => p.extraction.gaps))].filter(t => !topics.includes(t));
  return [...topics.map(t => `## ${t}\n${facts.filter(f => f.topic === t).map(f => `- ${f.text}\n  «${f.quote}»`).join('\n')}`),
    `\nПробелы: ${gaps.join(', ') || 'нет'}`, `Фактов: ${facts.length}; отброшено без цитаты: ${parts.reduce((n, p) => n + p.extraction.dropped, 0)}; конфликтов: ${parts.reduce((n, p) => n + p.extraction.conflicts.length, 0)}`].join('\n');
}
