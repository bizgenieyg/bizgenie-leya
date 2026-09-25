import { randomUUID } from 'node:crypto';
import { agentContext } from '../agents/index.js';
import type { DatabaseClient } from '../db/supabase.js';
import type { AIProvider } from '../providers/ai/ai-provider.interface.js';
import type { ClientRow, ConversationRow } from './tenant.service.js';
import type { ConversationMemory } from './context.service.js';
import type { OwnerSettings } from './owner-settings.service.js';
import { loadContext } from './context.service.js';
import { findExactKnowledgeAnswer } from './knowledge.service.js';
import { loadKnowledgeMaterials } from './knowledge-context.service.js';
import { meterAI } from './metered-providers.js';
import { behavior } from './runtime-settings.service.js';
import { discoveryQuestions, REPEAT_SIMILARITY_THRESHOLD } from '../config/discovery.js';
import { mergeClientProfile } from './client-profile.service.js';
import type { OwnerRequest, ReplyExtras } from './ai-fallback.service.js';

const normalizeReply = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length]!;
}
/** Same as the previous bot message after normalization, or less than 15 % of characters changed. */
export function isRepeat(reply: string, previous: string | null): boolean {
  if (!previous) return false;
  const a = normalizeReply(reply), b = normalizeReply(previous);
  if (!a || !b) return false;
  if (a === b) return true;
  return editDistance(a, b) / Math.max(a.length, b.length) < REPEAT_SIMILARITY_THRESHOLD;
}
import { entrySource, routeConversation } from './conversation-routing.service.js';
import { generateKnowledgeReplyResult, generateReceptionReply } from './ai-fallback.service.js';
import { renderText, replyLanguage } from './templates.service.js';
import { clientText, withoutRepeatedIntroduction, waitingText } from '../utils/assistant-text.js';
import { clientTimeZoneCommand } from '../utils/time-zone.js';
import { isWithinQuietHours, nextQuietHoursEnd } from './escalation.service.js';
import { limitClientText } from './usage-notifications.service.js';

export type PipelineOutcome = 'answered' | 'escalated' | 'limit' | 'paused';
export interface PipelineResult {
  reply: string | null;
  outcome: PipelineOutcome;
  pausedNote?: true;
  quietHours?: { active: true; until: string };
}
export interface PipelineSink {
  mode: 'whatsapp' | 'simulation';
  isConversationPaused(): Promise<boolean>;
  onClientOptOut(optedOut: boolean): Promise<void>;
  admit(): Promise<{ allowed: boolean; duplicate: boolean; unavailable?: boolean }>;
  afterAdmission(admission: { allowed: boolean; unavailable?: boolean }): Promise<void>;
  sendToClient(text: string): Promise<string | null>;
  /** `outboundId` is the queue row id; the sender stamps the WhatsApp id on the stored message later. */
  persistAssistantMessage(text: string, outboundId: string | null): Promise<void>;
  /** WhatsApp only, called after admission: prior chat history for a first contact. Never persisted. */
  loadChatHistory?: (() => Promise<{ messages: ConversationMemory[]; introduced: boolean }>) | undefined;
  /** One escalation per question (default: the whole message); returns the single client text sent. */
  createEscalation(responseLanguage: string, questions?: string[], answered?: string | null): Promise<string | null>;
  /** Owner request (demo, booking, callback…): one open request per client; returns the client text sent. */
  createRequest(responseLanguage: string, summary: string, repeatReply: string | null): Promise<string | null>;
  /** Summary of the client's open request, if any. */
  openRequest(): Promise<string | null>;
  loadClientProfile(): Promise<string>;
  saveClientProfile(profile: string): Promise<void>;
  markIntroduced(): Promise<void>;
  recordUsage(eventType: string, options?: { eventKey?: string; metadata?: Record<string, unknown> }): Promise<void>;
  recordAgentAction(actionType: string, input?: string, output?: string): Promise<void>;
  updateClientTimeZone(zone: string): Promise<void>;
  incrementReceptionCounter(): Promise<void>;
  attributeVoice?: ((agent: string) => Promise<void>) | undefined;
}
export interface PipelineInput {
  db: DatabaseClient;
  tenantId: string;
  text: string;
  client: ClientRow;
  conversation: ConversationRow;
  memory: { messages: ConversationMemory[]; introduced: boolean };
  settings: OwnerSettings;
  ai: AIProvider | null;
  model: AIProvider | null;
  usageKey: string;
  optedOut?: boolean;
  sink: PipelineSink;
  now?: Date;
}

export async function processCustomerMessage(input: PipelineInput): Promise<PipelineResult> {
  const { db, tenantId, text, client, conversation, memory, settings, ai, model, usageKey, sink } = input;
  const now = input.now ?? new Date();
  const language = replyLanguage(text, client);
  const firstInWindow = memory.messages.length === 1;
  const clientReply = (value: string) => withoutRepeatedIntroduction(value, memory.introduced);
  const pausedNote = sink.mode === 'simulation' && settings.auto_replies_paused ? true : undefined;
  const result = (reply: string | null, outcome: PipelineOutcome, quietHours?: { active: true; until: string }): PipelineResult =>
    ({ reply, outcome, ...(pausedNote ? { pausedNote } : {}), ...(quietHours ? { quietHours } : {}) });

  if (client.auto_reply_allowed === false) {
    await sink.onClientOptOut(input.optedOut === true);
    await sink.recordUsage('message_observed', { eventKey: usageKey, metadata: { reason: 'client_opt_out', billable: false } });
    return result(null, 'paused');
  }

  if (sink.mode === 'whatsapp' && (settings.auto_replies_paused || await sink.isConversationPaused())) {
    const context = await loadContext(db, tenantId);
    const exact = findExactKnowledgeAnswer(text, context.knowledge);
    let routedAgent = exact.matched ? 'FAQ' : conversation.routed_agent;
    if (!exact.matched) {
      const classification: Record<string, unknown>[] = [];
      const route = await routeConversation(db, tenantId, conversation, text, settings, ai, usage => classification.push(usage), firstInWindow);
      for (const metadata of classification) await agentContext.run({ agent: 'RECEPTION' }, () => sink.recordUsage('model_call', { eventKey: randomUUID(), metadata: { ...metadata, purpose: 'intent_classification', replies_paused: true } }));
      routedAgent = route.kind === 'agent' ? route.agent.name : 'RECEPTION';
    }
    await agentContext.run({ agent: routedAgent ?? 'RECEPTION' }, () => sink.recordUsage('message_observed', { eventKey: usageKey, metadata: { reason: 'paused', billable: false, classified: true } }));
    return result(null, 'paused');
  }

  const admission = await sink.admit();
  if (admission.duplicate) return result(null, 'paused');
  await sink.afterAdmission(admission);
  if (!admission.allowed) {
    const reply = clientReply(limitClientText(text, settings, language));
    await sink.sendToClient(reply);
    await sink.markIntroduced();
    memory.introduced = true;
    return result(reply, 'limit');
  }

  const history = sink.loadChatHistory ? await sink.loadChatHistory() : null;
  if (history?.messages.length) {
    memory.messages = [...history.messages, ...memory.messages];
    if (history.introduced && !memory.introduced) { await sink.markIntroduced(); memory.introduced = true; }
  }

  const context = await loadContext(db, tenantId);
  const exact = findExactKnowledgeAnswer(text, context.knowledge);
  if (exact.matched) return agentContext.run({ agent: conversation.routed_agent ?? 'CORE' }, async () => {
    await sink.recordUsage('message_received', { eventKey: usageKey });
    const reply = clientReply(clientText(exact.answer));
    const id = await sink.sendToClient(reply);
    await sink.persistAssistantMessage(exact.answer, id);
    await sink.markIntroduced();
    memory.introduced = true;
    await sink.recordAgentAction('faq_answer_exact', text, exact.answer);
    await sink.recordUsage('faq_answer_exact', { metadata: { knowledge_item_id: exact.knowledgeItemId } });
    return result(reply, 'answered');
  });

  const knowledge = await loadKnowledgeMaterials(db, tenantId, text, context, settings);
  context.materials = knowledge.materials;
  // Answer-model calls carry the knowledge size/mode to compare quality and cost after rollout.
  const knowledgeModel = meterAI(db, tenantId, model, { knowledge_chars: knowledge.chars, knowledge_mode: knowledge.mode });
  const classification: Record<string, unknown>[] = [];
  const route = await routeConversation(db, tenantId, conversation, text, settings, ai, usage => classification.push(usage), firstInWindow, sink.mode === 'whatsapp');
  for (const metadata of classification) await agentContext.run({ agent: 'RECEPTION' }, () => sink.recordUsage('model_call', { eventKey: randomUUID(), metadata: { ...metadata, purpose: 'intent_classification' } }));
  conversation.routed_agent = route.kind === 'agent' ? route.agent.name : 'RECEPTION';
  if (sink.mode === 'simulation' && firstInWindow) conversation.source_label = entrySource(text);
  const escalate = async (questions?: string[], answered?: string | null): Promise<PipelineResult> => {
    const reply = await sink.createEscalation(language, questions, answered);
    for (let i = 0; i < Math.max(1, questions?.length ?? 1); i++) await sink.recordUsage('escalation_created');
    if (reply) memory.introduced = true;
    const quiet = reply && isWithinQuietHours(settings, now) ? nextQuietHoursEnd(settings, now) : null;
    return result(reply, 'escalated', quiet ? { active: true, until: quiet.toISOString() } : undefined);
  };

  const config = behavior(settings);
  const clientProfile = await sink.loadClientProfile();
  const extras: ReplyExtras = { clientProfile, openRequest: await sink.openRequest(),
    discoveryQuestions: discoveryQuestions(config.client_discovery_questions, context.business?.business_sector, language) };
  const lastAssistant = [...memory.messages].reverse().find(item => item.fromMe)?.text ?? null;
  const updateProfile = async (facts: string[] | null | undefined) => {
    if (!facts) return;
    const next = mergeClientProfile(clientProfile, facts, now, settings.time_zone ?? 'Asia/Jerusalem');
    if (next !== null) await sink.saveClientProfile(next);
  };
  const request = async (req: OwnerRequest, repeatReply: string | null): Promise<PipelineResult> => {
    const summary = req.time ? `${req.summary}\n${renderText(settings, 'owner.request_time', config.owner_language, { time: req.time })}` : req.summary;
    const reply = await sink.createRequest(language, summary, repeatReply ? clientReply(repeatReply) : null);
    await sink.recordUsage('request_created');
    if (reply) memory.introduced = true;
    return result(reply, 'escalated');
  };

  if (route.kind === 'reception') return agentContext.run({ agent: 'RECEPTION' }, async () => {
    await sink.recordUsage('message_received', { eventKey: usageKey });
    const clarification = renderText(settings, 'client.reception_question', language);
    let reception = await generateReceptionReply(context, text, clarification, knowledgeModel, memory.messages, memory.introduced, language, extras);
    if (!reception.request && reception.reply && isRepeat(reception.reply, lastAssistant))
      reception = await generateReceptionReply(context, text, clarification, knowledgeModel, memory.messages, memory.introduced, language, { ...extras, avoidRepeat: lastAssistant });
    await updateProfile(reception.profile);
    if (reception.request) return request(reception.request, reception.reply);
    if (reception.escalate || !reception.reply || isRepeat(reception.reply, lastAssistant)) return escalate();
    const reply = clientReply(reception.reply);
    const id = await sink.sendToClient(reply);
    await sink.persistAssistantMessage(reception.reply, id);
    await sink.incrementReceptionCounter();
    await sink.markIntroduced();
    memory.introduced = true;
    return result(reply, 'answered');
  });
  if (route.kind === 'escalate') return agentContext.run({ agent: 'RECEPTION' }, async () => {
    await sink.recordUsage('message_received', { eventKey: usageKey });
    return escalate();
  });

  const agent = route.agent;
  return agentContext.run({ agent: agent.name }, async () => {
    await sink.recordUsage('message_received', { eventKey: usageKey });
    await sink.attributeVoice?.(agent.name);
    const clientZone = clientTimeZoneCommand(text);
    if (clientZone) {
      await sink.updateClientTimeZone(clientZone);
      const confirmation = renderText(settings, 'client.timezone_saved', language, { zone: clientZone });
      const quiet = isWithinQuietHours(settings, now);
      const reply = clientReply(confirmation + (quiet ? ' ' + waitingText(text, { at: nextQuietHoursEnd(settings, now), ownerZone: settings.time_zone ?? 'UTC', clientZone }, settings, language) : ''));
      await sink.sendToClient(reply);
      await sink.markIntroduced();
      memory.introduced = true;
      return result(reply, 'answered');
    }
    let agentResult: PipelineResult | null = null;
    await agent.execute({ answerFromKnowledge: async () => {
      let answer = await generateKnowledgeReplyResult(context, text, knowledgeModel, agent.systemPrompt, memory.messages, memory.introduced, language, extras);
      // Never send the same text twice in a row: regenerate once, then hand the message to the owner.
      if (!answer.request && !answer.unanswered.length && answer.reply && isRepeat(answer.reply, lastAssistant)) {
        answer = await generateKnowledgeReplyResult(context, text, knowledgeModel, agent.systemPrompt, memory.messages, memory.introduced, language, { ...extras, avoidRepeat: lastAssistant });
        if (!answer.request && answer.reply && isRepeat(answer.reply, lastAssistant)) { await updateProfile(answer.profile); agentResult = await escalate(); return; }
      }
      await updateProfile(answer.profile);
      if (answer.request) { agentResult = await request(answer.request, answer.reply); return; }
      if (answer.unanswered.length) {
        if (answer.reply) await sink.recordAgentAction('knowledge_ai_answer');
        for (const question of answer.unanswered) await sink.recordAgentAction('knowledge_missing', question);
        agentResult = await escalate(answer.unanswered, answer.reply ? clientReply(answer.reply) : null);
        return;
      }
      if (answer.reply) {
        const reply = clientReply(answer.reply);
        const id = await sink.sendToClient(reply);
        await sink.persistAssistantMessage(answer.reply, id);
        await sink.markIntroduced();
        memory.introduced = true;
        await sink.recordAgentAction('knowledge_ai_answer');
        await sink.recordUsage('knowledge_ai_answer');
        agentResult = result(reply, 'answered');
        return;
      }
      if (answer.missingKnowledge) await sink.recordAgentAction('knowledge_missing', text);
      agentResult = await escalate();
    } });
    return agentResult ?? result(null, 'paused');
  });
}
