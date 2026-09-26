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
import { agentIntent, asksListedQuestion, discoveryGate, normalizeDialogState, replyQuestions, untilFirstQuestion, type DialogState, type DiscoveryGate } from './dialog-state.js';
import { isAcknowledgement, isBareGreeting, withoutLeadingGreeting } from '../utils/small-talk.js';
import { analyzeChatHistory } from './chat-history-analysis.service.js';
import { assignConversationRoute } from './conversation-routing.service.js';
import { registry } from '../agents/index.js';
import { discoveryQuestions, REPEAT_SIMILARITY_THRESHOLD } from '../config/discovery.js';
import { mergeClientProfile, profileFacts } from './client-profile.service.js';
import type { OwnerRequest, ReplyExtras } from './ai-fallback.service.js';

/** First word of the WhatsApp display name when it looks like a name. */
const firstName = (name: string | null | undefined) => { const word = (name ?? '').trim().split(/\s+/)[0] ?? ''; return /^[\p{L}][\p{L}'-]{1,30}$/u.test(word) ? word : null; };
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
import { languageOf, renderGreeting, renderText, replyLanguage } from './templates.service.js';
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
  createEscalation(responseLanguage: string, questions?: string[], answered?: string | null, options?: { modelUnavailable?: boolean }): Promise<string | null>;
  loadDialogState(): Promise<unknown>;
  saveDialogState(state: DialogState): Promise<void>;
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
      const route = await routeConversation(db, tenantId, conversation, text, settings, ai, usage => classification.push(usage), firstInWindow, true, true);
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

  const config = behavior(settings);
  const state = normalizeDialogState(await sink.loadDialogState());
  const finish = async (value: PipelineResult): Promise<PipelineResult> => { await sink.saveDialogState(state); return value; };
  const context = await loadContext(db, tenantId);
  let clientProfile = await sink.loadClientProfile();
  const lastAssistant = [...memory.messages].reverse().find(item => item.fromMe)?.text ?? null;

  // WhatsApp history on first contact: analysed once per client (intent + up to 5 facts), never quoted back.
  if (history?.messages.length && !state.history_analyzed) {
    state.history_analyzed = true;
    const analysis = await analyzeChatHistory(meterAI(db, tenantId, model, { purpose: 'history_analysis' }), history.messages);
    if (analysis) {
      if (state.intent === 'unknown' && analysis.intent !== 'unknown') state.intent = analysis.intent;
      const next = mergeClientProfile(clientProfile, [...profileFacts(clientProfile), ...analysis.facts], now, settings.time_zone ?? 'Asia/Jerusalem');
      if (next !== null) { await sink.saveClientProfile(next); clientProfile = next; }
    }
  }
  const knownClient = memory.introduced || !!history?.messages.length || memory.messages.some(item => item.fromMe);
  const send = async (reply: string, stored = reply): Promise<void> => {
    const id = await sink.sendToClient(reply);
    await sink.persistAssistantMessage(stored, id);
    await sink.markIntroduced();
    memory.introduced = true;
  };

  // A bare greeting is answered by the owner's template: no model call, no qualification question.
  if (isBareGreeting(text)) return agentContext.run({ agent: 'RECEPTION' }, async () => {
    await sink.recordUsage('message_received', { eventKey: usageKey });
    const reply = renderGreeting(settings, knownClient ? 'client.greeting_known' : 'client.greeting', language, {
      assistant_name: context.assistant?.assistant_name, owner_name: context.business?.owner_name,
      business_name: context.business?.business_name, client_first_name: firstName(client.name) });
    await send(reply);
    state.stage = state.intent === 'unknown' ? 'intent_unknown' : 'intent_known';
    return finish(result(reply, 'answered'));
  });
  // Thanks / ok / 👍: a fixed short reply, or silence right after that same reply. No routing, no questions.
  if (isAcknowledgement(text)) return agentContext.run({ agent: conversation.routed_agent ?? 'RECEPTION' }, async () => {
    await sink.recordUsage('message_received', { eventKey: usageKey });
    // "👍" has no language of its own: answer in the language of the conversation so far.
    const ackLanguage = /\p{L}/u.test(text) ? language : lastAssistant ? languageOf(lastAssistant) : (client.language ?? language);
    const reply = renderText(settings, 'client.acknowledgement', ackLanguage);
    if (lastAssistant && isRepeat(lastAssistant, reply)) return finish(result(null, 'answered'));
    await send(reply);
    return finish(result(reply, 'answered'));
  });

  // "Привет, сколько стоит…": the greeting is dropped and the rest handled as usual.
  const question = withoutLeadingGreeting(text);
  state.client_turns += 1;
  if (state.stage === 'request' || state.stage === 'greeting') state.stage = state.intent === 'unknown' ? 'intent_unknown' : 'intent_known';

  const exact = findExactKnowledgeAnswer(question, context.knowledge);
  if (exact.matched) return agentContext.run({ agent: conversation.routed_agent ?? 'CORE' }, async () => {
    await sink.recordUsage('message_received', { eventKey: usageKey });
    const reply = clientReply(clientText(exact.answer));
    await send(reply, exact.answer);
    await sink.recordAgentAction('faq_answer_exact', question, exact.answer);
    await sink.recordUsage('faq_answer_exact', { metadata: { knowledge_item_id: exact.knowledgeItemId } });
    return finish(result(reply, 'answered'));
  });

  // "часовой пояс UTC+3" is a command handled by code whatever the route.
  const clientZone = clientTimeZoneCommand(question);
  if (clientZone) return agentContext.run({ agent: conversation.routed_agent ?? 'RECEPTION' }, async () => {
    await sink.recordUsage('message_received', { eventKey: usageKey });
    await sink.updateClientTimeZone(clientZone);
    const confirmation = renderText(settings, 'client.timezone_saved', language, { zone: clientZone });
    const quiet = isWithinQuietHours(settings, now);
    const reply = clientReply(confirmation + (quiet ? ' ' + waitingText(question, { at: nextQuietHoursEnd(settings, now), ownerZone: settings.time_zone ?? 'UTC', clientZone }, settings, language) : ''));
    await sink.sendToClient(reply);
    await sink.markIntroduced();
    memory.introduced = true;
    return finish(result(reply, 'answered'));
  });

  const knowledge = await loadKnowledgeMaterials(db, tenantId, question, context, settings);
  context.materials = knowledge.materials;
  // Answer-model calls carry the knowledge size/mode to compare quality and cost after rollout.
  const knowledgeModel = meterAI(db, tenantId, model, { knowledge_chars: knowledge.chars, knowledge_mode: knowledge.mode });
  const route = await routeConversation(db, tenantId, conversation, question, settings, ai, undefined, firstInWindow, sink.mode === 'whatsapp');
  conversation.routed_agent = route.kind === 'agent' ? route.agent.name : 'RECEPTION';
  if (route.kind === 'agent') { state.intent = agentIntent(route.agent.name); state.stage = 'intent_known'; }
  if (sink.mode === 'simulation' && firstInWindow) conversation.source_label = entrySource(question);
  const escalate = async (questions?: string[], answered?: string | null, options: { modelUnavailable?: boolean } = {}): Promise<PipelineResult> => {
    const reply = await sink.createEscalation(language, questions, answered, options);
    for (let i = 0; i < Math.max(1, questions?.length ?? 1); i++) await sink.recordUsage('escalation_created', options.modelUnavailable ? { metadata: { failure_reason: 'model_unavailable' } } : undefined);
    if (reply) memory.introduced = true;
    const quiet = reply && isWithinQuietHours(settings, now) ? nextQuietHoursEnd(settings, now) : null;
    return finish(result(reply, 'escalated', quiet ? { active: true, until: quiet.toISOString() } : undefined));
  };

  const questions = discoveryQuestions(config.client_discovery_questions, context.business?.business_sector, language);
  const extras: ReplyExtras = { clientProfile, openRequest: await sink.openRequest() };
  const updateProfile = async (facts: string[] | null | undefined) => {
    if (!facts) return;
    const next = mergeClientProfile(clientProfile, facts, now, settings.time_zone ?? 'Asia/Jerusalem');
    if (next !== null) { await sink.saveClientProfile(next); clientProfile = next; }
  };
  const request = async (req: OwnerRequest, repeatReply: string | null): Promise<PipelineResult> => {
    const summary = req.time ? `${req.summary}\n${renderText(settings, 'owner.request_time', config.owner_language, { time: req.time })}` : req.summary;
    const reply = await sink.createRequest(language, summary, repeatReply ? clientReply(repeatReply) : null);
    await sink.recordUsage('request_created');
    if (reply) memory.introduced = true;
    state.stage = 'request';
    return finish(result(reply, 'escalated'));
  };
  /** More than one question, or a needs question while the gate is closed. */
  const questionViolation = (reply: string | null, gate: DiscoveryGate) =>
    !!reply && (replyQuestions(reply).length > 1 || (gate.mode === 'closed' && asksListedQuestion(reply, questions)));

  if (route.kind === 'reception') return agentContext.run({ agent: 'RECEPTION' }, async () => {
    await sink.recordUsage('message_received', { eventKey: usageKey });
    const clarification = renderText(settings, 'client.reception_question', language);
    const closed: DiscoveryGate = { mode: 'closed' };
    let reception = await generateReceptionReply(context, question, clarification, knowledgeModel, memory.messages, memory.introduced, language, { ...extras, discovery: closed });
    if (!reception.request && reception.reply && (isRepeat(reception.reply, lastAssistant) || questionViolation(reception.reply, closed)))
      reception = await generateReceptionReply(context, question, clarification, knowledgeModel, memory.messages, memory.introduced, language,
        { ...extras, discovery: closed, limitQuestions: true, ...(isRepeat(reception.reply, lastAssistant) ? { avoidRepeat: lastAssistant } : {}) });
    if (reception.failure) return escalate(undefined, null, { modelUnavailable: true });
    await updateProfile(reception.profile);
    if (reception.intent === 'sale' || reception.intent === 'support') {
      const agentName = reception.intent === 'sale' ? 'SALE' : 'SUPPORT';
      if (registry.byName(agentName, settings)) {
        conversation.routed_agent = agentName;
        if (sink.mode === 'whatsapp') await assignConversationRoute(db, tenantId, conversation.id, agentName);
      }
      state.intent = reception.intent; state.stage = 'intent_known';
    } else state.stage = 'intent_unknown';
    if (reception.request) return request(reception.request, reception.reply);
    if (reception.unanswered?.length) {
      for (const item of reception.unanswered) await sink.recordAgentAction('knowledge_missing', item);
      return escalate(reception.unanswered, reception.reply ? clientReply(reception.reply) : null);
    }
    if (reception.escalate || !reception.reply || isRepeat(reception.reply, lastAssistant)) return escalate();
    const reply = clientReply(questionViolation(reception.reply, closed) ? untilFirstQuestion(reception.reply) : reception.reply);
    await send(reply, reception.reply);
    await sink.incrementReceptionCounter();
    return finish(result(reply, 'answered'));
  });
  if (route.kind === 'escalate') return agentContext.run({ agent: 'RECEPTION' }, async () => {
    await sink.recordUsage('message_received', { eventKey: usageKey });
    return escalate();
  });

  const agent = route.agent;
  return agentContext.run({ agent: agent.name }, async () => {
    await sink.recordUsage('message_received', { eventKey: usageKey });
    await sink.attributeVoice?.(agent.name);
    const gate = discoveryGate(state, questions, true);
    const agentExtras: ReplyExtras = { ...extras, discovery: gate };
    let agentResult: PipelineResult | null = null;
    await agent.execute({ answerFromKnowledge: async () => {
      let answer = await generateKnowledgeReplyResult(context, question, knowledgeModel, agent.systemPrompt, memory.messages, memory.introduced, language, agentExtras);
      // Never send the same text twice in a row, never more than one question: regenerate once.
      const repeated = !answer.request && !answer.unanswered.length && !!answer.reply && isRepeat(answer.reply, lastAssistant);
      if (!answer.failure && !answer.request && !answer.unanswered.length && answer.reply && (repeated || questionViolation(answer.reply, gate))) {
        answer = await generateKnowledgeReplyResult(context, question, knowledgeModel, agent.systemPrompt, memory.messages, memory.introduced, language,
          { ...agentExtras, limitQuestions: true, ...(repeated ? { avoidRepeat: lastAssistant } : {}) });
        if (!answer.request && answer.reply && isRepeat(answer.reply, lastAssistant)) { await updateProfile(answer.profile); agentResult = await escalate(); return; }
      }
      if (answer.failure) { agentResult = await escalate(undefined, null, { modelUnavailable: true }); return; }
      await updateProfile(answer.profile);
      if (gate.mode !== 'closed' && (answer.askedQuestion || answer.questionKnown)) {
        state.discovery_asked = [...state.discovery_asked, gate.question];
        if (answer.askedQuestion) state.last_question_turn = state.client_turns;
      }
      if (answer.request) { agentResult = await request(answer.request, answer.reply); return; }
      if (answer.unanswered.length) {
        if (answer.reply) await sink.recordAgentAction('knowledge_ai_answer');
        for (const item of answer.unanswered) await sink.recordAgentAction('knowledge_missing', item);
        agentResult = await escalate(answer.unanswered, answer.reply ? clientReply(answer.reply) : null);
        return;
      }
      if (answer.reply) {
        const reply = clientReply(questionViolation(answer.reply, gate) ? untilFirstQuestion(answer.reply) : answer.reply);
        await send(reply, answer.reply);
        await sink.recordAgentAction('knowledge_ai_answer');
        await sink.recordUsage('knowledge_ai_answer');
        agentResult = await finish(result(reply, 'answered'));
        return;
      }
      if (answer.missingKnowledge) await sink.recordAgentAction('knowledge_missing', question);
      agentResult = await escalate();
    } });
    return agentResult ?? finish(result(null, 'paused'));
  });
}
