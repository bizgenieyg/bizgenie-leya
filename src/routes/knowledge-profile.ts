import express, { Router } from 'express';
import { supabase } from '../db/supabase.js';
import { HttpError } from '../utils/http-error.js';
import { isUuid } from '../services/tenant.service.js';
import { objectBody } from '../utils/validation.js';
import { createEmbeddingProvider } from '../providers/embedding/index.js';
import type { EmbeddingProvider } from '../providers/embedding/embedding-provider.interface.js';
import { archiveFact, confirmSource, knowledgeProfile, updateFact } from '../services/business-facts.service.js';
import { createSource, sourceWithDrafts } from '../services/knowledge-sources.service.js';
import { decideAuditItem, openAuditItems } from '../services/knowledge-audit.service.js';

/** "Что знает Лея" (task R). Mounted under the admin router: ADMIN_SECRET, the cabinet proxies per tenant. */
export const knowledgeProfileRouter = Router();
const tenant = (value: unknown) => { if (typeof value !== 'string' || !isUuid(value)) throw new HttpError(400, 'tenantId must be a UUID'); return value; };
const id = (value: unknown) => { if (typeof value !== 'string' || !isUuid(value)) throw new HttpError(400, 'Invalid id'); return value; };
let embedder: EmbeddingProvider | null | undefined;
const sharedEmbedder = () => { if (embedder === undefined) embedder = createEmbeddingProvider(); return embedder; };

knowledgeProfileRouter.get('/knowledge/profile', async (request, response) => {
  const tenantId = tenant(request.query.tenantId);
  const waiting = await supabase.from('escalations').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('kind', 'question').in('status', ['pending', 'reminding']);
  if (waiting.error) throw new Error('Escalations unavailable');
  const assistant = await supabase.from('assistant_profiles').select('assistant_name').eq('tenant_id', tenantId).maybeSingle();
  response.setHeader('Cache-Control', 'no-store');
  response.json({ ...await knowledgeProfile(supabase, tenantId), audit: await openAuditItems(supabase, tenantId), waiting_questions: waiting.count ?? 0, assistant_name: typeof assistant.data?.assistant_name === 'string' ? assistant.data.assistant_name : null });
});
knowledgeProfileRouter.post('/knowledge/sources/link', async (request, response) => {
  const url = objectBody(request.body).url;
  const { id: sourceId } = await createSource(supabase, tenant(request.query.tenantId), { kind: 'link', url: typeof url === 'string' ? url : '' });
  response.status(202).json({ id: sourceId, status: 'processing' });
});
// Pasted text as text/plain: up to 50 000 characters of Cyrillic/Hebrew exceed the global 100 kB JSON limit,
// which stays as it is for the webhook.
knowledgeProfileRouter.post('/knowledge/sources/text', express.text({ type: 'text/plain', limit: '1mb' }), async (request, response) => {
  const topic = typeof request.query.topic === 'string' ? request.query.topic.slice(0, 40) : null;
  const { id: sourceId } = await createSource(supabase, tenant(request.query.tenantId), { kind: 'text', text: typeof request.body === 'string' ? request.body : '', topic });
  response.status(202).json({ id: sourceId, status: 'processing' });
});
knowledgeProfileRouter.post('/knowledge/sources/file', express.raw({ type: 'application/octet-stream', limit: '10mb' }), async (request, response) => {
  const tenantId = tenant(request.query.tenantId), name = decodeURIComponent(request.header('x-file-name') ?? ''), type = request.header('x-file-type') ?? '';
  if (!name || name.length > 255 || !Buffer.isBuffer(request.body) || !request.body.length) throw new HttpError(400, 'Invalid knowledge file', { code: 'knowledge_invalid_file' });
  const { id: sourceId } = await createSource(supabase, tenantId, { kind: 'file', name, type, data: request.body });
  response.status(202).json({ id: sourceId, status: 'processing' });
});
knowledgeProfileRouter.get('/knowledge/sources/:id', async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.json(await sourceWithDrafts(supabase, tenant(request.query.tenantId), id(request.params.id)));
});
knowledgeProfileRouter.post('/knowledge/sources/:id/confirm', async (request, response) => {
  response.json(await confirmSource(supabase, tenant(request.query.tenantId), id(request.params.id)));
});
knowledgeProfileRouter.patch('/knowledge/facts/:id', async (request, response) => {
  response.json(await updateFact(supabase, tenant(request.query.tenantId), id(request.params.id), objectBody(request.body).text, sharedEmbedder()));
});
knowledgeProfileRouter.delete('/knowledge/facts/:id', async (request, response) => {
  await archiveFact(supabase, tenant(request.query.tenantId), id(request.params.id));
  response.status(204).send();
});
knowledgeProfileRouter.post('/knowledge/audit/:id', async (request, response) => {
  const body = objectBody(request.body);
  response.json(await decideAuditItem(supabase, tenant(request.query.tenantId), id(request.params.id), body.action, body.text, sharedEmbedder()));
});
