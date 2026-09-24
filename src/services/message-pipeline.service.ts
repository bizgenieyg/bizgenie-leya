import { randomUUID } from 'node:crypto';
import { agentContext } from '../agents/index.js';
import type { DatabaseClient } from '../db/supabase.js';
import type { AIProvider } from '../providers/ai/ai-provider.interface.js';
import type { ClientRow, ConversationRow } from './tenant.service.js';
import type { ConversationMemory } from './context.service.js';
import type { OwnerSettings } from './owner-settings.service.js';
import { loadContext } from './context.service.js';
import { findExactKnowledgeAnswer } from './knowledge.service.js';
import { findSemanticKnowledge } from './semantic-knowledge.service.js';
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
  createEscalation(responseLanguage: string): Promise<string | null>;
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

  context.materials = await findSemanticKnowledge(db, tenantId, text);
  const classification: Record<string, unknown>[] = [];
  const route = await routeConversation(db, tenantId, conversation, text, settings, ai, usage => classification.push(usage), firstInWindow, sink.mode === 'whatsapp');
  for (const metadata of classification) await agentContext.run({ agent: 'RECEPTION' }, () => sink.recordUsage('model_call', { eventKey: randomUUID(), metadata: { ...metadata, purpose: 'intent_classification' } }));
  conversation.routed_agent = route.kind === 'agent' ? route.agent.name : 'RECEPTION';
  if (sink.mode === 'simulation' && firstInWindow) conversation.source_label = entrySource(text);
  const escalate = async (): Promise<PipelineResult> => {
    const reply = await sink.createEscalation(language);
    await sink.recordUsage('escalation_created');
    if (reply) memory.introduced = true;
    const quiet = reply && isWithinQuietHours(settings, now) ? nextQuietHoursEnd(settings, now) : null;
    return result(reply, 'escalated', quiet ? { active: true, until: quiet.toISOString() } : undefined);
  };

  if (route.kind === 'reception') return agentContext.run({ agent: 'RECEPTION' }, async () => {
    await sink.recordUsage('message_received', { eventKey: usageKey });
    const clarification = renderText(settings, 'client.reception_question', language);
    const reception = await generateReceptionReply(context, text, clarification, model, memory.messages, memory.introduced, language);
    if (reception.escalate || !reception.reply) return escalate();
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
      const answer = await generateKnowledgeReplyResult(context, text, model, agent.systemPrompt, memory.messages, memory.introduced, language);
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
