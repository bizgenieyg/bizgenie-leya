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
import { agentIntent, asksListedQuestion, discoveryGate, markAnswered, normalizeDialogState, replyQuestions, untilFirstQuestion, type DialogState, type DiscoveryGate } from './dialog-state.js';
import { isAcknowledgement, isBareGreeting, withoutLeadingGreeting } from '../utils/small-talk.js';
import { analyzeChatHistory } from './chat-history-analysis.service.js';
import { assignConversationRoute } from './conversation-routing.service.js';
import { registry } from '../agents/index.js';
import { discoveryQuestions, REPEAT_SIMILARITY_THRESHOLD } from '../config/discovery.js';
import { mergeClientProfile, profileFacts } from './client-profile.service.js';
import type { OwnerRequest, ReplyExtras } from './ai-fallback.service.js';
import type { EmbeddingProvider } from '../providers/embedding/embedding-provider.interface.js';
import { agreement, hasCallToAction, isDecline, isDirectRequest, usableFirstName } from './client-consent.js';
import { isSemanticRepeat } from './semantic-repeat.service.js';
import { recordUsageEvent } from './usage.service.js';
import { CALL_TO_ACTION_PATTERN } from '../config/consent.js';

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
  createRequest(responseLanguage: string, summary: string, repeatReply: string | null, clientFirstName: string | null): Promise<string | null>;
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
  /** Embeddings for the semantic repeat check; null or absent — only the textual check runs. */
  embedder?: EmbeddingProvider | null;
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
  // An offer to pass the request to the owner waits `request_offer_turns` client messages, then lapses.
  const offerAtStart = state.pending_offer;
  const finish = async (value: PipelineResult): Promise<PipelineResult> => {
    if (offerAtStart && state.pending_offer === offerAtStart && --state.pending_offer.turns_left < 1) delete state.pending_offer;
    await sink.saveDialogState(state);
    return value;
  };
  const context = await loadContext(db, tenantId);
  let clientProfile = await sink.loadClientProfile();
  const questions = discoveryQuestions(config.client_discovery_questions, context.business?.business_sector, language);
  const lastAssistant = [...memory.messages].reverse().find(item => item.fromMe)?.text ?? null;
  const recentBot = memory.messages.filter(item => item.fromMe).slice(-config.repeat_window).map(item => item.text);
  /** Only for the greeting template and the request confirmation; never "Мама" or a shop nickname. */
  const clientFirstName = () => usableFirstName(state.client_name ?? client.name, context.business?.business_name);
  const rememberName = (name: string | null | undefined) => { const usable = usableFirstName(name, context.business?.business_name); if (usable) state.client_name = usable; };

  // WhatsApp history on first contact: analysed once per client (intent + up to 5 facts), never quoted back.
  if (history?.messages.length && !state.history_analyzed) {
    state.history_analyzed = true;
    const analysis = await analyzeChatHistory(meterAI(db, tenantId, model, { purpose: 'history_analysis' }), history.messages, questions);
    if (analysis) {
      if (state.intent === 'unknown' && analysis.intent !== 'unknown') state.intent = analysis.intent;
      markAnswered(state, questions, analysis.answers);
      const next = mergeClientProfile(clientProfile, [...profileFacts(clientProfile), ...analysis.facts], now, settings.time_zone ?? 'Asia/Jerusalem');
      if (next !== null) { await sink.saveClientProfile(next); clientProfile = next; }
    }
  }
  const knownClient = memory.introduced || !!history?.messages.length || memory.messages.some(item => item.fromMe);
  const send = async (reply: string, stored = reply): Promise<void> => {
    if (hasCallToAction(reply)) state.last_cta_turn = state.client_turns;
    const id = await sink.sendToClient(reply);
    await sink.persistAssistantMessage(stored, id);
    await sink.markIntroduced();
    memory.introduced = true;
  };

  /** Creates (or extends) the owner request and sends the confirmation. */
  const createRequestNow = async (req: OwnerRequest, repeatReply: string | null): Promise<PipelineResult> => {
    delete state.pending_offer;
    const summary = req.time ? `${req.summary}\n${renderText(settings, 'owner.request_time', config.owner_language, { time: req.time })}` : req.summary;
    const reply = await sink.createRequest(language, summary, repeatReply ? clientReply(repeatReply) : null, clientFirstName());
    await sink.recordUsage('request_created');
    if (reply) memory.introduced = true;
    state.stage = 'request';
    return finish(result(reply, 'escalated'));
  };
  // Answer to "Передать владельцу…?": "да" creates the request without a model call; "нет" is remembered.
  if (state.pending_offer) {
    const agreed = agreement(text);
    if (agreed) return agentContext.run({ agent: conversation.routed_agent ?? 'RECEPTION' }, async () => {
      await sink.recordUsage('message_received', { eventKey: usageKey });
      rememberName(agreed.rest);
      const offer = state.pending_offer!;
      return createRequestNow({ summary: offer.summary, time: offer.time }, null);
    });
    if (isDecline(text)) { delete state.pending_offer; state.offer_declined = true; }
  }

  // A bare greeting is answered by the owner's template: no model call, no qualification question.
  if (isBareGreeting(text)) return agentContext.run({ agent: 'RECEPTION' }, async () => {
    await sink.recordUsage('message_received', { eventKey: usageKey });
    const reply = renderGreeting(settings, knownClient ? 'client.greeting_known' : 'client.greeting', language, {
      assistant_name: context.assistant?.assistant_name, owner_name: context.business?.owner_name,
      business_name: context.business?.business_name, client_first_name: clientFirstName() });
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

  const extras: ReplyExtras = { clientProfile, openRequest: await sink.openRequest(), discoveryIndex: questions };
  /** Facts replace the profile; the questions they answer are recorded by code for the discovery gate. */
  const updateProfile = async (facts: string[] | null | undefined, answers: number[] = []) => {
    markAnswered(state, questions, answers);
    if (!facts) return;
    const next = mergeClientProfile(clientProfile, facts, now, settings.time_zone ?? 'Asia/Jerusalem');
    if (next !== null) { await sink.saveClientProfile(next); clientProfile = next; }
  };
  /**
   * The model asked for an owner request. Created only on a direct request ("хочу демо"), a "yes" to an
   * earlier offer, or new details for an already open request; otherwise the client is asked first.
   */
  const request = async (req: OwnerRequest, modelReply: string | null, consent: boolean | null | undefined): Promise<PipelineResult> => {
    if (extras.openRequest || isDirectRequest(question) || (state.pending_offer && consent === true)) {
      state.offer_declined = false;
      return createRequestNow(req, modelReply);
    }
    // No question marks left in the model's part: the offer is the single question of this message.
    const answer = modelReply ? clientText(modelReply).split(/(?<=[.!?…])\s+/).filter(sentence => !sentence.trim().endsWith('?')).join(' ').trim() : '';
    if (state.offer_declined) {
      const reply = clientReply(answer || renderText(settings, 'client.reception_question', language));
      await send(reply);
      return finish(result(reply, 'answered'));
    }
    const owner = context.business?.owner_name?.trim();
    const topic = (req.topic ?? req.summary.split('\n')[0] ?? '').replace(/[«»"]/g, '').slice(0, 60).trim();
    const offer = renderText(settings, owner ? 'client.request_offer' : 'client.request_offer_generic', language, { owner_name: owner ?? '', summary_short: topic });
    const reply = clientReply([answer, clientFirstName() ? offer : `${offer} ${renderText(settings, 'client.ask_name', language)}`].filter(Boolean).join('\n\n'));
    state.pending_offer = { summary: req.summary, time: req.time, topic, turns_left: config.request_offer_turns };
    await send(reply);
    await sink.recordAgentAction('request_offered', question);
    return finish(result(reply, 'answered'));
  };
  /** "да"/"нет" to the offer recognised by the model when the dictionaries did not catch it. */
  const consentWithoutRequest = async (consent: boolean | null | undefined): Promise<PipelineResult | null> => {
    if (!state.pending_offer || consent == null) return null;
    if (consent) return createRequestNow({ summary: state.pending_offer.summary, time: state.pending_offer.time }, null);
    delete state.pending_offer; state.offer_declined = true;
    return null;
  };
  /** The same call to action (demo, booking, passing to the owner) at most once per `cta_min_gap_turns`. */
  const ctaTooSoon = (reply: string) => hasCallToAction(reply) && state.last_cta_turn !== undefined && state.client_turns - state.last_cta_turn < config.cta_min_gap_turns;
  const withoutCallToAction = (reply: string) => reply.split(/(?<=[.!?…])\s+/).filter(sentence => !CALL_TO_ACTION_PATTERN.test(sentence)).join(' ').trim() || null;
  /** Near-verbatim (fast) or the same in other words (embeddings) as one of the last bot replies. */
  const textRepeat = async (reply: string) => recentBot.some(previous => isRepeat(reply, previous))
    || (await isSemanticRepeat(reply, recentBot, input.embedder ?? null, config.semantic_repeat_threshold,
      usage => recordUsageEvent(db, { tenantId, eventType: 'embedding_call', quantity: usage.inputTokens,
        metadata: { purpose: 'repeat_check', model: usage.model, billable_message: false, ...(sink.mode === 'simulation' ? { simulation: true } : {}) } }))).repeat;
  /** More than one question, or a needs question while the gate is closed. */
  const questionViolation = (reply: string | null, gate: DiscoveryGate) =>
    !!reply && (replyQuestions(reply).length > 1 || (gate.mode === 'closed' && asksListedQuestion(reply, questions)));

  if (route.kind === 'reception') return agentContext.run({ agent: 'RECEPTION' }, async () => {
    await sink.recordUsage('message_received', { eventKey: usageKey });
    const clarification = renderText(settings, 'client.reception_question', language);
    const closed: DiscoveryGate = { mode: 'closed' };
    let reception = await generateReceptionReply(context, question, clarification, knowledgeModel, memory.messages, memory.introduced, language, { ...extras, discovery: closed });
    const repeated = !reception.failure && !reception.request && !!reception.reply && (ctaTooSoon(reception.reply) || await textRepeat(reception.reply));
    let stillRepeated = false;
    if (!reception.failure && !reception.request && reception.reply && (repeated || questionViolation(reception.reply, closed))) {
      reception = await generateReceptionReply(context, question, clarification, knowledgeModel, memory.messages, memory.introduced, language,
        { ...extras, discovery: closed, limitQuestions: true, ...(repeated ? { avoidRepeat: recentBot } : {}) });
      if (!reception.request && reception.reply && ctaTooSoon(reception.reply)) reception.reply = withoutCallToAction(reception.reply);
      stillRepeated = repeated && !reception.request && !!reception.reply && await textRepeat(reception.reply);
    }
    if (reception.failure) return escalate(undefined, null, { modelUnavailable: true });
    await updateProfile(reception.profile, reception.profileAnswers);
    rememberName(reception.clientName);
    if (reception.intent === 'sale' || reception.intent === 'support') {
      const agentName = reception.intent === 'sale' ? 'SALE' : 'SUPPORT';
      if (registry.byName(agentName, settings)) {
        conversation.routed_agent = agentName;
        if (sink.mode === 'whatsapp') await assignConversationRoute(db, tenantId, conversation.id, agentName);
      }
      state.intent = reception.intent; state.stage = 'intent_known';
    } else state.stage = 'intent_unknown';
    if (reception.request) return request(reception.request, reception.reply, reception.consent);
    const consented = await consentWithoutRequest(reception.consent);
    if (consented) return consented;
    if (reception.unanswered?.length) {
      for (const item of reception.unanswered) await sink.recordAgentAction('knowledge_missing', item);
      return escalate(reception.unanswered, reception.reply ? clientReply(reception.reply) : null);
    }
    if (reception.escalate || !reception.reply || stillRepeated) return escalate();
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
      // Never repeat one of the last replies (verbatim or in meaning) or the same call to action, never more
      // than one question: regenerate once; a reply that still repeats goes to the owner.
      const plain = !answer.failure && !answer.request && !answer.unanswered.length && !!answer.reply;
      const repeated = plain && (ctaTooSoon(answer.reply!) || await textRepeat(answer.reply!));
      if (plain && (repeated || questionViolation(answer.reply, gate))) {
        answer = await generateKnowledgeReplyResult(context, question, knowledgeModel, agent.systemPrompt, memory.messages, memory.introduced, language,
          { ...agentExtras, limitQuestions: true, ...(repeated ? { avoidRepeat: recentBot } : {}) });
        if (!answer.request && answer.reply && ctaTooSoon(answer.reply)) answer.reply = withoutCallToAction(answer.reply);
        if (repeated && !answer.request && answer.reply && await textRepeat(answer.reply)) { await updateProfile(answer.profile, answer.profileAnswers); agentResult = await escalate(); return; }
      }
      if (answer.failure) { agentResult = await escalate(undefined, null, { modelUnavailable: true }); return; }
      await updateProfile(answer.profile, answer.profileAnswers);
      rememberName(answer.clientName);
      if (gate.mode !== 'closed' && answer.askedQuestion) {
        state.discovery_asked = [...state.discovery_asked, gate.question];
        state.last_question_turn = state.client_turns;
      }
      if (answer.request) { agentResult = await request(answer.request, answer.reply, answer.consent); return; }
      const consented = await consentWithoutRequest(answer.consent);
      if (consented) { agentResult = consented; return; }
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
