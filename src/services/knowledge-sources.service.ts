import type { DatabaseClient } from '../db/supabase.js';
import type { AIProvider } from '../providers/ai/ai-provider.interface.js';
import { createTaskAIProvider } from '../providers/ai/index.js';
import type { EmbeddingProvider } from '../providers/embedding/embedding-provider.interface.js';
import { createEmbeddingProvider } from '../providers/embedding/index.js';
import { HttpError } from '../utils/http-error.js';
import { behavior } from './runtime-settings.service.js';
import { loadOwnerSettings } from './owner-settings.service.js';
import { reserveKnowledgeIndex, reserveKnowledgeVoice } from './knowledge-index-rate-limit.js';
import { recordUsageEvent } from './usage.service.js';
import { DOCUMENT_TYPES, clean, extract } from './knowledge-documents.service.js';
import { readLink, type LinkLimits } from './link-reader.service.js';
import { extractFacts, type Extraction } from './fact-extraction.service.js';
import { activeFacts, saveExtraction } from './business-facts.service.js';
import { meterAI } from './metered-providers.js';
import { runAudit } from './knowledge-audit.service.js';

/**
 * "Добавить что угодно" (task R): text, file, link or price-list photo → a knowledge source → facts as
 * drafts ("Лея поняла так"). The request returns at once with the source id; processing runs in the
 * background (one leya-api instance) and the cabinet polls the source status.
 */
export const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
export type SourceInput =
  | { kind: 'text'; text: string; topic?: string | null }
  /** Task Z: a voice note already transcribed (the audio is gone); stored as kind 'voice'. */
  | { kind: 'voice'; text: string; topic?: string | null }
  | { kind: 'file'; name: string; type: string; data: Buffer }
  | { kind: 'link'; url: string };
export interface SourceDeps { taskAI?: AIProvider | null; embedder?: EmbeddingProvider | null; readLink?: typeof readLink; audit?: boolean }

const PHOTO_PROMPT = `Перепиши весь текст с фотографии (прайс, меню, каталог, объявление, витрина) дословно, сохраняя строки, названия услуг или товаров, цены и валюту. Таблицу — строками «название — цена». Ничего не добавляй и не исправляй. Если текста нет — верни пустую строку. Верни только текст.`;

const check = (error: unknown, message: string) => { if (error) throw new Error(message); };
async function setStatus(db: DatabaseClient, tenantId: string, id: string, patch: Record<string, unknown>) {
  check((await db.from('knowledge_sources').update({ ...patch, updated_at: new Date().toISOString() }).eq('tenant_id', tenantId).eq('id', id)).error, 'Knowledge source update failed');
}

export async function createSource(db: DatabaseClient, tenantId: string, input: SourceInput, deps: SourceDeps = {}): Promise<{ id: string; done: Promise<void> }> {
  const config = behavior(await loadOwnerSettings(db, tenantId));
  let row: Record<string, unknown>;
  if (input.kind === 'text' || input.kind === 'voice') {
    const text = clean(String(input.text ?? ''));
    if (!text) throw new HttpError(400, 'Empty text', { code: input.kind === 'voice' ? 'voice_empty' : 'source_empty' });
    if (text.length > config.source_text_max_chars) throw new HttpError(413, 'Text too long', { code: 'source_text_too_long' });
    row = { kind: input.kind, title: input.topic ?? null, original_text: text };
  } else if (input.kind === 'file') {
    const image = IMAGE_TYPES.has(input.type);
    if (!image && !DOCUMENT_TYPES.has(input.type)) throw new HttpError(400, 'Unsupported file type', { code: 'knowledge_file_type' });
    if (!input.data.length || input.data.length > config.knowledge_max_file_bytes) throw new HttpError(413, 'File too large', { code: 'knowledge_file_too_large' });
    row = { kind: image ? 'photo' : 'file', title: input.name.slice(0, 300) };
  } else {
    const url = String(input.url ?? '').trim();
    if (!/^https?:\/\//i.test(url) || url.length > 2000) throw new HttpError(400, 'Invalid link', { code: 'link_invalid' });
    row = { kind: 'link', url };
  }
  const reservation = await reserveKnowledgeIndex(tenantId, config.knowledge_indexing_hourly_limit, config.knowledge_indexing_daily_limit);
  if (!reservation.allowed) throw new HttpError(429, 'Knowledge indexing limit reached', { code: 'knowledge_index_limit' });
  const inserted = await db.from('knowledge_sources').insert({ tenant_id: tenantId, status: 'processing', ...row }).select('id').single();
  check(inserted.error || !inserted.data, 'Knowledge source save failed');
  const id = String(inserted.data!.id);
  const done = processSource(db, tenantId, id, input, deps).then(() => undefined, () => undefined);
  return { id, done };
}

/** Source → text → facts (drafts) → audit of the new facts. Failures end in status 'failed' with a code. */
export async function processSource(db: DatabaseClient, tenantId: string, id: string, input: SourceInput, deps: SourceDeps = {}): Promise<Extraction | null> {
  const config = behavior(await loadOwnerSettings(db, tenantId));
  const taskAI = meterAI(db, tenantId, deps.taskAI === undefined ? createTaskAIProvider() : deps.taskAI, { purpose: 'knowledge_extraction', billable_message: false });
  const embedder = deps.embedder === undefined ? createEmbeddingProvider() : deps.embedder;
  try {
    if (!taskAI) throw new HttpError(503, 'Model unavailable', { code: 'source_model_unavailable' });
    let text = '', title: string | null = null;
    if (input.kind === 'text' || input.kind === 'voice') text = clean(input.text);
    else if (input.kind === 'file' && IMAGE_TYPES.has(input.type)) {
      const photo = await meterAI(db, tenantId, taskAI, { purpose: 'knowledge_photo' })!.generateReply({ systemPrompt: PHOTO_PROMPT, userMessage: 'Фото прикреплено.', images: [{ mimeType: input.type, data: input.data.toString('base64') }] });
      text = clean(photo.text); title = input.name;
    } else if (input.kind === 'file') { text = clean((await extract(input)).text); title = input.name; }
    else {
      const limits: LinkLimits = { timeoutMs: config.link_timeout_seconds * 1000, maxBytes: config.link_max_bytes, maxPages: config.link_max_pages };
      const page = await (deps.readLink ?? readLink)(input.url, limits);
      title = page.title || null;
      text = clean(page.pages.map(p => `${p.title ? `# ${p.title}\n` : ''}${p.text}`).join('\n\n'));
    }
    if (!text) throw new HttpError(422, 'No text', { code: input.kind === 'file' && IMAGE_TYPES.has(input.type) ? 'photo_no_text' : 'source_empty' });
    text = text.slice(0, 200_000);
    await setStatus(db, tenantId, id, { original_text: text, ...(title ? { title: title.slice(0, 300) } : {}) });
    const existing = (await activeFacts(db, tenantId)).map(f => ({ id: f.id, topic: f.topic, text: f.text }));
    const extraction = await extractFacts(taskAI, text, existing, config.extraction_chunk_chars, title);
    await saveExtraction(db, tenantId, id, extraction, { status: 'draft', createdBy: 'extract', embedder, duplicateThreshold: config.fact_duplicate_threshold });
    await setStatus(db, tenantId, id, { status: 'ready', error: null });
    // Task Z: after knowledge is loaded, ask the owner about what is still missing.
    try { const { syncGapQuestions, ensureInterviewJob } = await import('./owner-interview.service.js'); await syncGapQuestions(db, tenantId); await ensureInterviewJob(db, tenantId); }
    catch { console.warn('owner_interview_schedule_failed', { tenantId }); }
    if (deps.audit !== false) {
      try { await runAudit(db, tenantId, { sourceId: id, taskAI: deps.taskAI, embedder }); }
      catch { console.warn('knowledge_audit_failed', { tenantId }); }
    }
    return extraction;
  } catch (error) {
    const code = error instanceof HttpError && typeof (error.details as { code?: unknown } | undefined)?.code === 'string'
      ? String((error.details as { code: string }).code) : 'source_failed';
    console.warn('knowledge_source_failed', { tenantId, code });
    await setStatus(db, tenantId, id, { status: 'failed', error: code }).catch(() => undefined);
    return null;
  }
}

/** Source with its draft facts ("Лея поняла так") and status for polling. */
export async function sourceWithDrafts(db: DatabaseClient, tenantId: string, id: string) {
  const source = await db.from('knowledge_sources').select('id,kind,title,url,status,error,created_at').eq('tenant_id', tenantId).eq('id', id).maybeSingle();
  check(source.error, 'Knowledge source unavailable');
  if (!source.data) throw new HttpError(404, 'Source not found', { code: 'source_not_found' });
  const facts = await db.from('business_facts').select('id,topic,text,quote,status').eq('tenant_id', tenantId).eq('source_id', id).eq('status', 'draft').order('created_at', { ascending: true });
  check(facts.error, 'Draft facts unavailable');
  const conflicts = await db.from('knowledge_audit_items').select('id,topic,before_text,suggested_text').eq('tenant_id', tenantId).eq('check_type', 'conflict').eq('status', 'open');
  check(conflicts.error, 'Conflicts unavailable');
  return { ...source.data, drafts: facts.data ?? [], conflicts: conflicts.data ?? [] };
}

/**
 * Task Z: a voice note from the cabinet → STT → a 'voice' source, then the same path as text. Service limits
 * (knowledge_voice_*); the audio buffer is wiped right after recognition and never stored.
 */
export async function createVoiceSource(db: DatabaseClient, tenantId: string, audio: { type: string; data: Buffer }, topic: string | null,
  deps: SourceDeps & { stt?: import('../providers/stt/stt-provider.interface.js').STTProvider | null } = {}): Promise<{ id: string; done: Promise<void> }> {
  const config = behavior(await loadOwnerSettings(db, tenantId));
  const mime = audio.type.split(';')[0]!.trim().toLowerCase();
  try {
    if (!/^audio\/(webm|ogg|mp4|mpeg|m4a|x-m4a|aac|wav|x-wav|mp3)$/.test(mime)) throw new HttpError(400, 'Unsupported audio', { code: 'voice_type' });
    if (!audio.data.length || audio.data.length > config.media_max_bytes) throw new HttpError(413, 'Audio too large', { code: 'voice_too_long' });
    const { parseBuffer } = await import('music-metadata');
    const duration = (await parseBuffer(audio.data, { mimeType: mime }, { duration: true })).format.duration;
    if (duration !== undefined && Number.isFinite(duration) && duration > config.knowledge_voice_max_seconds) throw new HttpError(413, 'Voice note too long', { code: 'voice_too_long' });
    const reservation = await reserveKnowledgeVoice(tenantId, config.knowledge_voice_hourly_limit, config.knowledge_voice_daily_limit);
    if (!reservation.allowed) throw new HttpError(429, 'Voice limit reached', { code: 'voice_limit' });
    const stt = deps.stt === undefined ? (await import('../providers/stt/index.js')).createSTTProvider() : deps.stt;
    if (!stt) throw new HttpError(503, 'Voice unavailable', { code: 'voice_unavailable' });
    let text = '';
    try {
      const result = await stt.transcribe(audio.data, mime, config.stt_timeout_seconds);
      await recordUsageEvent(db, { tenantId, eventType: 'stt_call', metadata: { status: 'success', purpose: 'knowledge_voice', billable_message: false, ...result.usage } });
      text = result.text.trim();
    } catch { await recordUsageEvent(db, { tenantId, eventType: 'stt_call', metadata: { status: 'failed', purpose: 'knowledge_voice', billable_message: false } }); throw new HttpError(502, 'Voice not recognised', { code: 'voice_failed' }); }
    if (!text) throw new HttpError(422, 'Nothing recognised', { code: 'voice_empty' });
    return await createSource(db, tenantId, { kind: 'voice', text, topic }, deps);
  } finally { audio.data.fill(0); }
}
