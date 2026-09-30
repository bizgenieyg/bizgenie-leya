import express, { Router } from 'express';
import { supabase } from '../db/supabase.js';
import { HttpError } from '../utils/http-error.js';
import { isUuid } from '../services/tenant.service.js';
import { objectBody } from '../utils/validation.js';
import { activateInstruction, instructionTarget, listInstructions, loadCore, MAX_INSTRUCTION_CHARS, uploadInstruction } from '../services/instructions.service.js';
import { CORE_CONFIG_KEY } from '../config/instructions.js';
import { importOwnerQuestions } from '../services/owner-interview.service.js';

/** Task Z operator endpoints (ADMIN_SECRET via the admin router): instructions, core, owner-interview questions. */
export const instructionsRouter = Router();
const target = (query: Record<string, unknown>) => {
  if (query.tenantId !== undefined && (typeof query.tenantId !== 'string' || !isUuid(query.tenantId))) throw new HttpError(400, 'tenantId must be a UUID');
  return instructionTarget({ tenantId: query.tenantId, demoKey: query.demoKey });
};
const plain = express.text({ type: 'text/plain', limit: '256kb' });

instructionsRouter.get('/instructions', async (request, response) => { response.setHeader('Cache-Control', 'no-store'); response.json(await listInstructions(supabase, target(request.query))); });
instructionsRouter.post('/instructions', plain, async (request, response) => {
  response.status(201).json(await uploadInstruction(supabase, target(request.query), typeof request.body === 'string' ? request.body : null));
});
instructionsRouter.post('/instructions/activate', async (request, response) => {
  response.json(await activateInstruction(supabase, target(request.query), objectBody(request.body).version));
});
instructionsRouter.get('/core-instruction', async (_request, response) => { response.setHeader('Cache-Control', 'no-store'); response.type('text/plain').send(await loadCore(supabase)); });
instructionsRouter.put('/core-instruction', plain, async (request, response) => {
  const text = typeof request.body === 'string' ? request.body : '';
  if (!text.trim() || text.length > MAX_INSTRUCTION_CHARS) throw new HttpError(400, 'Invalid core', { code: 'instruction_invalid' });
  const saved = await supabase.from('system_config').upsert({ key: CORE_CONFIG_KEY, value: text, updated_at: new Date().toISOString() });
  if (saved.error) throw new Error('Core save failed');
  response.status(204).send();
});
instructionsRouter.delete('/core-instruction', async (_request, response) => {
  const removed = await supabase.from('system_config').delete().eq('key', CORE_CONFIG_KEY);
  if (removed.error) throw new Error('Core reset failed');
  response.status(204).send();
});
/** Owner-interview questions as a markdown list: "- [launch] …" / "- [normal] …". */
instructionsRouter.post('/owner-questions', plain, async (request, response) => {
  const tenantId = request.query.tenantId;
  if (typeof tenantId !== 'string' || !isUuid(tenantId)) throw new HttpError(400, 'tenantId must be a UUID');
  response.status(201).json(await importOwnerQuestions(supabase, tenantId, typeof request.body === 'string' ? request.body : ''));
});
