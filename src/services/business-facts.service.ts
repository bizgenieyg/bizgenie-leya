import type { DatabaseClient } from '../db/supabase.js';
import type { EmbeddingProvider } from '../providers/embedding/embedding-provider.interface.js';
import { HttpError } from '../utils/http-error.js';
import { CORE_TOPICS, isKnowledgeTopic, KNOWLEDGE_TOPICS, offerTopicName, requiredTopics, TOPIC_PROMPT_NAMES, type KnowledgeTopic } from '../config/knowledge-topics.js';
import { offeringKind } from '../config/discovery.js';
import { normalizeSpaces, type Extraction } from './fact-extraction.service.js';
import { recordUsageEvent } from './usage.service.js';

export type FactStatus = 'draft' | 'active' | 'archived';
export type FactOrigin = 'extract' | 'owner' | 'correction' | 'onboarding' | 'migration' | 'audit';
export interface FactRow { id: string; topic: string; text: string; status: FactStatus; source_id: string | null; quote: string | null; created_by: string; created_at: string; updated_at: string; embedding?: unknown }

const check = (error: unknown, message: string) => { if (error) throw new Error(message); };
const sameText = (a: string, b: string) => normalizeSpaces(a).toLowerCase() === normalizeSpaces(b).toLowerCase();
const cosine = (a: number[], b: number[]) => { let d = 0, x = 0, y = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) { d += a[i]! * b[i]!; x += a[i]! ** 2; y += b[i]! ** 2; } return x && y ? d / Math.sqrt(x * y) : 0; };
/** Stored vectors come back as JSON text (pgvector) or arrays (tests). */
export const vectorOf = (value: unknown): number[] | null => {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === 'string') { try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed.map(Number) : null; } catch { return null; } }
  return null;
};

/** Embeddings for facts (RETRIEVAL_DOCUMENT); null without a provider or on failure — facts are saved anyway. */
export async function embedTexts(db: DatabaseClient, tenantId: string, embedder: EmbeddingProvider | null, texts: string[], purpose: string): Promise<number[][] | null> {
  if (!embedder || !texts.length) return null;
  try {
    const result = await embedder.embed(texts, 'RETRIEVAL_DOCUMENT');
    await recordUsageEvent(db, { tenantId, eventType: 'embedding_call', quantity: result.inputTokens ?? Math.ceil(texts.join(' ').length / 4),
      metadata: { purpose, model: embedder.model, billable_message: false } });
    return result.vectors.length === texts.length ? result.vectors : null;
  } catch { console.warn('fact_embedding_failed', { tenantId }); return null; }
}

export async function activeFacts(db: DatabaseClient, tenantId: string, withEmbedding = false): Promise<FactRow[]> {
  const r = await db.from('business_facts').select(`id,topic,text,status,source_id,quote,created_by,created_at,updated_at${withEmbedding ? ',embedding,embedding_model' : ''}`)
    .eq('tenant_id', tenantId).eq('status', 'active').order('created_at', { ascending: true });
  check(r.error, 'Business facts unavailable');
  return (r.data ?? []) as unknown as FactRow[];
}

/**
 * Saves extracted facts of one source: duplicates of active facts of the same topic (embedding cosine ≥
 * threshold, or the same text without embeddings) are skipped; conflicts become "Было / Стало" cards and
 * never overwrite a fact silently. New facts are drafts until the owner confirms (migration: active).
 */
export async function saveExtraction(db: DatabaseClient, tenantId: string, sourceId: string, extraction: Extraction,
  options: { status: 'draft' | 'active'; createdBy: FactOrigin; embedder: EmbeddingProvider | null; duplicateThreshold: number }): Promise<{ saved: number; duplicates: number; conflicts: number }> {
  const existing = await activeFacts(db, tenantId, true);
  const vectors = await embedTexts(db, tenantId, options.embedder, extraction.facts.map(f => f.text), 'fact_embedding');
  const accepted: Array<{ topic: KnowledgeTopic; text: string; quote: string; vector: number[] | null }> = [];
  let duplicates = 0;
  extraction.facts.forEach((fact, i) => {
    const vector = vectors?.[i] ?? null;
    const peers = [...existing.filter(f => f.topic === fact.topic).map(f => ({ text: f.text, vector: vectorOf(f.embedding) })), ...accepted.filter(f => f.topic === fact.topic)];
    const duplicate = peers.some(p => sameText(p.text, fact.text) || (vector && p.vector && cosine(vector, p.vector) >= options.duplicateThreshold));
    if (duplicate) { duplicates++; return; }
    accepted.push({ ...fact, vector });
  });
  if (accepted.length) {
    const inserted = await db.from('business_facts').insert(accepted.map(f => ({ tenant_id: tenantId, topic: f.topic, text: f.text, quote: f.quote, source_id: sourceId,
      status: options.status, created_by: options.createdBy, ...(f.vector ? { embedding: JSON.stringify(f.vector), embedding_model: options.embedder!.model } : {}) })));
    check(inserted.error, 'Business facts save failed');
  }
  let conflicts = 0;
  for (const conflict of extraction.conflicts) {
    const fact = existing.find(f => f.id === conflict.fact_id);
    if (!fact || sameText(fact.text, conflict.new_text)) continue;
    const card = await db.from('knowledge_audit_items').insert({ tenant_id: tenantId, kind: 'audit', check_type: 'conflict', topic: fact.topic, fact_id: fact.id,
      fact_fingerprint: normalizeSpaces(fact.text), before_text: fact.text, suggested_text: conflict.new_text, reason: conflict.quote.slice(0, 300) });
    check(card.error, 'Conflict card save failed');
    conflicts++;
  }
  return { saved: accepted.length, duplicates, conflicts };
}

/** "Верно": all drafts of a source become active. */
export async function confirmSource(db: DatabaseClient, tenantId: string, sourceId: string): Promise<{ activated: number }> {
  const drafts = await db.from('business_facts').select('id').eq('tenant_id', tenantId).eq('source_id', sourceId).eq('status', 'draft');
  check(drafts.error, 'Draft facts unavailable');
  const ids = (drafts.data ?? []).map(row => String(row.id));
  if (ids.length) check((await db.from('business_facts').update({ status: 'active', updated_at: new Date().toISOString() }).eq('tenant_id', tenantId).in('id', ids)).error, 'Facts confirm failed');
  return { activated: ids.length };
}

async function factById(db: DatabaseClient, tenantId: string, id: string): Promise<FactRow> {
  const r = await db.from('business_facts').select('id,topic,text,status,source_id,quote,created_by,created_at,updated_at').eq('tenant_id', tenantId).eq('id', id).maybeSingle();
  check(r.error, 'Business fact unavailable');
  if (!r.data) throw new HttpError(404, 'Fact not found', { code: 'fact_not_found' });
  return r.data as unknown as FactRow;
}

export function validFactText(value: unknown): string {
  const text = typeof value === 'string' ? normalizeSpaces(value) : '';
  if (!text || text.length > 500 || /[<>{}]/.test(text)) throw new HttpError(400, 'Invalid fact', { code: 'fact_invalid' });
  return text;
}

/**
 * Owner edit. A draft changes in place; an active fact gets a new version (supersedes_id) and the old one
 * is archived, so what Leya said before stays traceable. The quote no longer backs owner wording.
 */
export async function updateFact(db: DatabaseClient, tenantId: string, id: string, value: unknown, embedder: EmbeddingProvider | null, createdBy: FactOrigin = 'owner'): Promise<FactRow> {
  const text = validFactText(value), fact = await factById(db, tenantId, id);
  if (fact.status === 'archived') throw new HttpError(409, 'Fact archived', { code: 'fact_archived' });
  const vector = (await embedTexts(db, tenantId, embedder, [text], 'fact_embedding'))?.[0] ?? null;
  const embedding = vector ? { embedding: JSON.stringify(vector), embedding_model: embedder!.model } : { embedding: null, embedding_model: null };
  const now = new Date().toISOString();
  if (fact.status === 'draft') {
    check((await db.from('business_facts').update({ text, ...embedding, updated_at: now }).eq('tenant_id', tenantId).eq('id', id)).error, 'Fact update failed');
    return { ...fact, text, updated_at: now };
  }
  const inserted = await db.from('business_facts').insert({ tenant_id: tenantId, topic: fact.topic, text, source_id: fact.source_id, quote: null, status: 'active',
    supersedes_id: fact.id, created_by: createdBy, ...embedding }).select('id,topic,text,status,source_id,quote,created_by,created_at,updated_at').single();
  check(inserted.error || !inserted.data, 'Fact update failed');
  check((await db.from('business_facts').update({ status: 'archived', updated_at: now }).eq('tenant_id', tenantId).eq('id', id)).error, 'Fact archive failed');
  return inserted.data as unknown as FactRow;
}

export async function archiveFact(db: DatabaseClient, tenantId: string, id: string): Promise<void> {
  const fact = await factById(db, tenantId, id);
  if (fact.status === 'draft') { check((await db.from('business_facts').delete().eq('tenant_id', tenantId).eq('id', id)).error, 'Fact delete failed'); return; }
  check((await db.from('business_facts').update({ status: 'archived', updated_at: new Date().toISOString() }).eq('tenant_id', tenantId).eq('id', id)).error, 'Fact archive failed');
}

/** A fact the owner stated (answer to a card or to a client question): active at once, no quote needed. */
export async function addOwnerFact(db: DatabaseClient, tenantId: string, topic: string, value: unknown, embedder: EmbeddingProvider | null,
  options: { createdBy?: FactOrigin; kind?: 'owner_answer' | 'correction' | 'onboarding'; title?: string | null } = {}): Promise<FactRow> {
  const text = validFactText(value);
  const safeTopic = isKnowledgeTopic(topic) ? topic : 'other';
  const source = await db.from('knowledge_sources').insert({ tenant_id: tenantId, kind: options.kind ?? 'owner_answer', title: options.title?.slice(0, 300) ?? null, original_text: text, status: 'ready' }).select('id').single();
  check(source.error || !source.data, 'Knowledge source save failed');
  const vector = (await embedTexts(db, tenantId, embedder, [text], 'fact_embedding'))?.[0] ?? null;
  const inserted = await db.from('business_facts').insert({ tenant_id: tenantId, topic: safeTopic, text, source_id: String(source.data!.id), quote: null, status: 'active',
    created_by: options.createdBy ?? 'owner', ...(vector ? { embedding: JSON.stringify(vector), embedding_model: embedder!.model } : {}) })
    .select('id,topic,text,status,source_id,quote,created_by,created_at,updated_at').single();
  check(inserted.error || !inserted.data, 'Fact save failed');
  return inserted.data as unknown as FactRow;
}

/** Profile for the cabinet: topics with facts, which required topics are empty, drafts per source. */
export async function knowledgeProfile(db: DatabaseClient, tenantId: string) {
  const tenant = await db.from('tenants').select('business_sector').eq('id', tenantId).maybeSingle();
  check(tenant.error, 'Tenant unavailable');
  const facts = await db.from('business_facts').select('id,topic,text,status,source_id,quote,created_by,created_at,updated_at').eq('tenant_id', tenantId).in('status', ['active', 'draft']).order('created_at', { ascending: true });
  check(facts.error, 'Business facts unavailable');
  const rows = (facts.data ?? []) as unknown as FactRow[];
  const sourceIds = [...new Set(rows.map(f => f.source_id).filter((id): id is string => !!id))];
  const sources = sourceIds.length ? await db.from('knowledge_sources').select('id,kind,title,url,created_at').eq('tenant_id', tenantId).in('id', sourceIds) : { data: [], error: null };
  check(sources.error, 'Knowledge sources unavailable');
  const recent = await db.from('knowledge_sources').select('id,kind,title,status,error,created_at').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(10);
  check(recent.error, 'Knowledge sources unavailable');
  const required = requiredTopics(tenant.data?.business_sector as string | null);
  const active = rows.filter(f => f.status === 'active');
  const topics = KNOWLEDGE_TOPICS.map(topic => {
    const list = active.filter(f => f.topic === topic);
    return { topic, required: required.includes(topic), facts: list, updated_at: list.reduce<string | null>((m, f) => !m || f.updated_at > m ? f.updated_at : m, null) };
  });
  return { topics, offering: offeringKind(tenant.data?.business_sector as string | null), filled: topics.filter(t => t.required && t.facts.length).length, required: required.length,
    drafts: rows.filter(f => f.status === 'draft'), sources: sources.data ?? [], recent_sources: recent.data ?? [] };
}

/** Markdown profile grouped by topic, for the answer prompt. */
export const factsMarkdown = (facts: Array<{ topic: string; text: string }>, sector?: string | null) => KNOWLEDGE_TOPICS
  .map(topic => ({ topic, list: facts.filter(f => f.topic === topic) })).filter(g => g.list.length)
  .map(g => `## ${g.topic === 'services_prices' ? offerTopicName(sector) : TOPIC_PROMPT_NAMES[g.topic]}\n${g.list.map(f => `- ${f.text}`).join('\n')}`).join('\n\n');

/**
 * Business profile for one answer (knowledge_mode='facts'): the whole profile when it fits
 * `fullChars`; otherwise core topics whole plus the facts nearest to the client's message.
 */
export async function factsForReply(db: DatabaseClient, tenantId: string, query: string, fullChars: number, searchResults: number, embedder: EmbeddingProvider | null): Promise<{ markdown: string; chars: number; mode: 'full' | 'search' }> {
  const facts = await activeFacts(db, tenantId);
  const tenant = await db.from('tenants').select('business_sector').eq('id', tenantId).maybeSingle();
  const sector = (tenant.data?.business_sector as string | null | undefined) ?? null;
  const all = factsMarkdown(facts, sector);
  if (all.length <= fullChars) return { markdown: all, chars: all.length, mode: 'full' };
  const core = facts.filter(f => (CORE_TOPICS as readonly string[]).includes(f.topic));
  let found: Array<{ topic: string; text: string }> = [];
  if (embedder) {
    try {
      const embedded = await embedder.embed([query], 'RETRIEVAL_QUERY');
      await recordUsageEvent(db, { tenantId, eventType: 'embedding_call', quantity: embedded.inputTokens ?? Math.ceil(query.length / 4), metadata: { purpose: 'fact_search', model: embedder.model, billable_message: false } });
      const r = await db.rpc('match_business_facts', { p_tenant_id: tenantId, p_embedding: JSON.stringify(embedded.vectors[0]), p_embedding_model: embedder.model, p_limit: searchResults + core.length });
      if (!r.error) found = ((r.data ?? []) as Array<{ topic: string; text: string }>).filter(f => !(CORE_TOPICS as readonly string[]).includes(f.topic)).slice(0, searchResults);
    } catch { console.warn('fact_search_failed', { tenantId }); }
  }
  const markdown = factsMarkdown([...core, ...found], sector);
  return { markdown, chars: markdown.length, mode: 'search' };
}
