import type { DatabaseClient } from '../db/supabase.js';
import type { AIProvider } from '../providers/ai/ai-provider.interface.js';
import type { EmbeddingProvider } from '../providers/embedding/embedding-provider.interface.js';
import { behavior, saveRuntimeSettings } from './runtime-settings.service.js';
import { loadOwnerSettings } from './owner-settings.service.js';
import { extractFacts, requiredGaps, type Extraction } from './fact-extraction.service.js';
import { requiredTopics, type KnowledgeTopic } from '../config/knowledge-topics.js';
import { TASK_PRICE_INPUT_PER_MILLION, TASK_PRICE_OUTPUT_PER_MILLION } from '../config/evals.js';
import { activeFacts, saveExtraction } from './business-facts.service.js';
import { meterAI } from './metered-providers.js';

/**
 * Current knowledge → business facts (task R, `npm run knowledge:migrate`). Q&A pairs and ready documents
 * become sources of kind 'migration' (documents by link, files and chunks untouched) and their facts are
 * active at once: the owner already approved this knowledge. Old tables stay; knowledge_mode='facts' is set
 * after a successful run and 'legacy' rolls it back. A dry run writes nothing.
 */
export interface MigrationPart { title: string; documentId: string | null; text: string; extraction: Extraction }
export interface MigrationResult { parts: MigrationPart[]; saved: number; sector: string | null; required: readonly KnowledgeTopic[]; gaps: KnowledgeTopic[] }
export async function migrateKnowledge(db: DatabaseClient, tenantId: string, ai: AIProvider, embedder: EmbeddingProvider | null, dryRun: boolean): Promise<MigrationResult> {
  const config = behavior(await loadOwnerSettings(db, tenantId));
  const tenant = await db.from('tenants').select('business_sector').eq('id', tenantId).maybeSingle();
  if (tenant.error) throw new Error('Tenant unavailable');
  const sector = (tenant.data?.business_sector as string | null | undefined) ?? null, required = requiredTopics(sector);
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
  // Gaps by code (R p. 2): required topics of the sector without facts — extracted ones in a dry run, active ones after saving.
  const topics = dryRun ? parts.flatMap(p => p.extraction.facts.map(f => f.topic)) : (await activeFacts(db, tenantId)).map(f => f.topic);
  return { parts, saved, sector, required, gaps: requiredGaps(required, topics, parts.flatMap(p => p.extraction.gaps)) };
}

/** Dry-run / run report: facts by topic, gaps, coverage of source blocks, dropped quotes, model calls and cost. */
export function formatMigration(result: Pick<MigrationResult, 'parts' | 'gaps'> & Partial<Pick<MigrationResult, 'sector' | 'required'>>): string {
  const parts = result.parts, facts = parts.flatMap(p => p.extraction.facts);
  const topics = [...new Set(facts.map(f => f.topic))];
  const lines = topics.map(t => `## ${t}\n${facts.filter(f => f.topic === t).map(f => `- ${f.text}\n  «${f.quote}»`).join('\n')}`);
  if (result.required) lines.push(`\nСфера: ${result.sector || 'не указана'}; обязательные темы: ${result.required.join(', ')}`);
  lines.push(`Пробелы: ${result.gaps.join(', ') || 'нет'}`);
  lines.push(`Фактов: ${facts.length}; отброшено без цитаты: ${parts.reduce((n, p) => n + p.extraction.dropped, 0)}; конфликтов: ${parts.reduce((n, p) => n + p.extraction.conflicts.length, 0)}`);
  for (const part of parts) {
    const c = part.extraction.coverage;
    if (c) {
      lines.push(`\n[${part.title}] Блоков: ${c.blocks}; покрыто: ${c.covered}; пропущено моделью с причиной: ${c.skipped.length}; не покрыто: ${c.uncovered.length}`);
      for (const s of c.skipped) lines.push(`  пропуск (${s.reason === 'service' ? 'служебный текст' : `дубликат: «${s.duplicate_of}»`}): ${s.block.replace(/\s+/g, ' ').slice(0, 160)}`);
      for (const u of c.uncovered) lines.push(`  НЕ ПОКРЫТО: ${u.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
    for (const r of part.extraction.rewritten ?? []) lines.push(`  переписан по цитате (${r.claims.join(', ')})${r.fallback ? ' → текст цитаты' : ''}: «${r.before}» → «${r.after}»`);
    for (const r of part.extraction.rejectedSkips ?? []) lines.push(`  «дубликат» не принят (нет в факте: ${r.missing.slice(0, 8).join(', ')}): ${r.block.replace(/\s+/g, ' ').slice(0, 120)}`);
    for (const d of part.extraction.droppedFacts ?? []) lines.push(`  отброшен: «${d.text}» — цитата «${d.quote}»${d.nearest ? `; ближайшее в источнике: «${d.nearest}»` : ''}`);
    const calls = part.extraction.calls ?? [];
    if (calls.length) {
      const sum = (k: 'input_tokens' | 'output_tokens' | 'thinking_tokens') => calls.reduce((n, c) => n + c[k], 0);
      const cost = sum('input_tokens') / 1e6 * TASK_PRICE_INPUT_PER_MILLION + (sum('output_tokens') + sum('thinking_tokens')) / 1e6 * TASK_PRICE_OUTPUT_PER_MILLION;
      lines.push(`  вызовов: ${calls.length} (повторных: ${calls.filter(c => c.retry).length}); finishReason: ${[...new Set(calls.map(c => c.finishReason))].join(', ')}; токены: вход ${sum('input_tokens')}, выход ${sum('output_tokens')}, рассуждения ${sum('thinking_tokens')}; ≈ $${cost.toFixed(4)}`);
    }
  }
  return lines.join('\n');
}
