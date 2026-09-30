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
import { loadFactsContext } from './reply-context.service.js';
import { answerByInstruction } from './instruction-engine.service.js';
import { createAIProvider } from '../providers/ai/index.js';
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
import { agreement, hasCallToAction, isDecline, isDirectRequest, preferredName, usableFirstName } from './client-consent.js';
import { isSemanticRepeat } from './semantic-repeat.service.js';
import { recordUsageEvent } from './usage.service.js';
import { CALL_TO_ACTION_PATTERN, CLAIMED_PASSED_PATTERN, INTEREST_PATTERN, OFFER_QUESTION_PATTERN } from '../config/consent.js';

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
/** Fields every model answer shares for the offer/request decision (task X). */
interface Settleable { reply: string | null; request?: OwnerRequest | null; consent?: boolean | null; offered?: { summary: string } | null; failure?: string }
/** The last sentence is a question that offers a meeting, demo, call, calculation or passing to the owner. */
export function isOfferQuestion(text: string): boolean {
  const last = text.trim().split(/(?<=[.!?…])\s+/).pop() ?? '';
  return /\?\s*$/.test(last) && OFFER_QUESTION_PATTERN.test(last);
}
const lastOfferSentence = (text: string) => (text.trim().split(/(?<=[.!?…])\s+/).pop() ?? text).slice(0, 200);
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
  createEscalation(responseLanguage: string, questions?: string[], answered?: string | null, options?: { modelUnavailable?: boolean; clientText?: string }): Promise<string | null>;
  /** Task Z: demo mode of this conversation (conversations / simulator_sessions demo_key, demo_turns). */
  loadDemo(): Promise<{ key: string | null; turns: number }>;
  saveDemo(demo: { key: string | null; turns: number }): Promise<void>;
  /** Task Z: a notice to the owner (data requests); simulator: recorded only. */
  notifyOwner(text: string, dedupeKey: string): Promise<void>;
  loadDialogState(): Promise<unknown>;
  saveDialogState(state: DialogState): Promise<void>;
  /** Owner request (demo, booking, callback…): one open request per client; returns the client text sent. */
  /** `confirmation`: the text for the client (model reply or template); null — the sink's own text (repeat of an open request). */
  createRequest(responseLanguage: string, summary: string, confirmation: string | null, clientFirstName: string | null): Promise<string | null>;
  /** Summary of the client's open request, if any. */
  openRequest(): Promise<string | null>;
  loadClientProfile(): Promise<string>;
  /** Name the client gave in the chat: clients.preferred_name (simulator: its session). */
  saveClientName(name: string): Promise<void>;
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
  let offerFromLastMessage: DialogState['pending_offer'] | undefined;
  const finish = async (value: PipelineResult): Promise<PipelineResult> => {
    if (offerAtStart && state.pending_offer === offerAtStart && --state.pending_offer.turns_left < 1) delete state.pending_offer;
    // An offer inferred from the last bot message lives for this answer only.
    if (offerFromLastMessage && state.pending_offer === offerFromLastMessage) delete state.pending_offer;
    await sink.saveDialogState(state);
    return value;
  };
  const context = await loadContext(db, tenantId);
  let clientProfile = await sink.loadClientProfile();
  const questions = discoveryQuestions(config.client_discovery_questions, context.business?.business_sector, language);
  const lastAssistant = [...memory.messages].reverse().find(item => item.fromMe)?.text ?? null;
  const recentBot = memory.messages.filter(item => item.fromMe).slice(-config.repeat_window).map(item => item.text);
  /** Only for the greeting template and the request confirmation: the name the client gave, else a usable display name. */
  const clientFirstName = () => preferredName(client.preferred_name) ?? usableFirstName(client.name, context.business?.business_name);
  /** Saved on the client (062), so it survives new conversations; `guessed` text (after "да, …") must look like a name. */
  const rememberName = async (name: string | null | undefined, guessed = false) => {
    const value = guessed ? usableFirstName(name, context.business?.business_name) : preferredName(name);
    if (!value || value === client.preferred_name) return;
    client.preferred_name = value;
    await sink.saveClientName(value);
  };

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

  const ownerName = context.business?.owner_name?.trim() || null;
  // Task Z: a tenant on reply_engine='instruction' with an active instruction answers by it; no routing, reception,
  // stages or gates. Without an active instruction it keeps the legacy path below.
  if (config.reply_engine === 'instruction') {
    state.client_turns += 1;
    const replyModel = config.reply_model ? meterAI(db, tenantId, createAIProvider(undefined, config.reply_model), { reply_engine: 'instruction' }) : meterAI(db, tenantId, model, { reply_engine: 'instruction' });
    let outcome: Awaited<ReturnType<typeof answerByInstruction>>;
    try {
      outcome = replyModel ? await answerByInstruction({ db, tenantId, text, language, settings, state, memory: memory.messages, model: replyModel,
        business: context.business ?? null, demo: await sink.loadDemo() }) : null;
    } catch {
      console.warn('instruction_reply_failed', { tenantId });
      return agentContext.run({ agent: 'RECEPTION' }, async () => {
        await sink.recordUsage('message_received', { eventKey: usageKey });
        const reply = await sink.createEscalation(language, undefined, null, { modelUnavailable: true });
        await sink.recordUsage('escalation_created', { metadata: { failure_reason: 'model_unavailable' } });
        return finish(result(reply, 'escalated'));
      });
    }
    if (outcome) {
      const done = outcome;
      return agentContext.run({ agent: 'INSTRUCTION' }, async () => {
        await sink.recordUsage('message_received', { eventKey: usageKey });
        await sink.saveDemo(done.demo);
        if (done.dataRequest) {
          const action = renderText(settings, `owner.data_request_${done.dataRequest}`, config.owner_language);
          await sink.notifyOwner(renderText(settings, 'owner.data_request', config.owner_language, { name: clientFirstName() ?? client.name ?? '', phone: client.phone ?? '', action }), `data-request:${usageKey}`);
        }
        const a = done.action;
        if (a.kind === 'silent') return finish(result(null, 'paused'));
        if (a.kind === 'request') {
          delete state.pending_offer;
          const reply = await sink.createRequest(language, a.summary, clientReply(a.text), clientFirstName());
          await sink.recordUsage('request_created');
          if (reply) memory.introduced = true;
          state.stage = 'request';
          return finish(result(reply, 'escalated'));
        }
        if (a.kind === 'ask_owner' || a.kind === 'human') {
          const reply = await sink.createEscalation(language, a.kind === 'ask_owner' ? [a.question] : undefined, null, { clientText: clientReply(a.text) });
          await sink.recordUsage('escalation_created', { metadata: { reason: a.kind } });
          if (reply) memory.introduced = true;
          return finish(result(reply, 'escalated'));
        }
        if (done.offer) state.pending_offer = { summary: done.offer.slice(0, 200), time: null, topic: done.offer.slice(0, 80), turns_left: config.request_offer_turns };
        const reply = clientReply(a.text);
        await send(reply, a.text);
        return finish(result(reply, 'answered'));
      });
    }
    state.client_turns -= 1;
  }
  /** Template confirmation (no model text): "Готово! Юрий свяжется с вами в четверг." + "как к вам обращаться?" when no name. */
  const templateConfirmation = (req: OwnerRequest) => {
    const text = renderGreeting(settings, 'client.request_sent', language, { owner_name: ownerName, client_first_name: clientFirstName(), time: req.time });
    return clientFirstName() ? text : `${text} ${renderText(settings, 'client.ask_name', language)}`;
  };
  /** Creates (or extends) the owner request. The client gets the model's confirmation, else the template. */
  const createRequestNow = async (req: OwnerRequest, modelReply: string | null, open: boolean): Promise<PipelineResult> => {
    delete state.pending_offer;
    state.offer_declined = false;
    const summary = req.time ? `${req.summary}\n${renderText(settings, 'owner.request_time', config.owner_language, { time: req.time })}` : req.summary;
    // A model text that still asks "передать?" is never a confirmation.
    const usable = modelReply && !isOfferQuestion(modelReply) ? clientReply(modelReply) : null;
    const reply = await sink.createRequest(language, summary, usable ?? (open ? null : clientReply(templateConfirmation(req))), clientFirstName());
    await sink.recordUsage('request_created');
    if (reply) memory.introduced = true;
    state.stage = 'request';
    return finish(result(reply, 'escalated'));
  };
  // Safety net (task X): the last bot message offered something as a question, but the flag was missed.
  if (!state.pending_offer && lastAssistant && isOfferQuestion(lastAssistant)) {
    offerFromLastMessage = { summary: lastOfferSentence(lastAssistant), time: null, topic: null, turns_left: 1 };
    state.pending_offer = offerFromLastMessage;
  }
  // Answer to an offer: "да" / "да хочу" creates the request without a model call; "нет" is remembered.
  if (state.pending_offer) {
    const agreed = agreement(text);
    if (agreed) return agentContext.run({ agent: conversation.routed_agent ?? 'RECEPTION' }, async () => {
      await sink.recordUsage('message_received', { eventKey: usageKey });
      await rememberName(agreed.rest, true);
      const offer = state.pending_offer!;
      return createRequestNow({ summary: offer.summary, time: offer.time }, null, !!await sink.openRequest());
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

  // knowledge_mode='facts' (task R): answers use only the business profile — no Q&A pairs, no raw files.
  const factsMode = config.knowledge_mode === 'facts';
  if (factsMode) context.knowledge = [];
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

  const knowledge = factsMode ? await loadFactsContext(db, tenantId, question, settings, input.embedder ?? null) : await loadKnowledgeMaterials(db, tenantId, question, context, settings);
  if ('businessProfile' in knowledge) {
    context.materials = []; context.businessProfile = knowledge.businessProfile;
    context.assistantRules = knowledge.assistantRules; context.assistantExamples = knowledge.assistantExamples;
  } else context.materials = knowledge.materials;
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

  const extras: ReplyExtras = { clientProfile, openRequest: await sink.openRequest(), discoveryIndex: questions,
    mayOffer: false, pendingOffer: state.pending_offer?.summary ?? null, needClientName: !clientFirstName(), ownerName };
  /** Facts replace the profile; the questions they answer are recorded by code for the discovery gate. */
  const updateProfile = async (facts: string[] | null | undefined, answers: number[] = []) => {
    markAnswered(state, questions, answers);
    if (!facts) return;
    const next = mergeClientProfile(clientProfile, facts, now, settings.time_zone ?? 'Asia/Jerusalem');
    if (next !== null) { await sink.saveClientProfile(next); clientProfile = next; }
  };
  /** Offers are allowed only after interest, or from turn 3 of a sale; never after a refusal or within cta_min_gap_turns. */
  const interest = INTEREST_PATTERN.test(question) || (!!lastAssistant && /\?\s*$/.test(lastAssistant.trim()) && !isOfferQuestion(lastAssistant) && !/\?\s*$/.test(question.trim()));
  const mayOffer = () => !state.offer_declined && (state.last_cta_turn === undefined || state.client_turns - state.last_cta_turn >= config.cta_min_gap_turns)
    && (interest || (state.client_turns >= 3 && state.intent === 'sale'));
  const offerMade = (r: Settleable) => !!r.reply && (!!r.offered || isOfferQuestion(r.reply));
  const dropSentences = (reply: string, drop: (sentence: string) => boolean) =>
    reply.split(/(?<=[.!?…])\s+/).filter(sentence => !drop(sentence)).join(' ').trim() || renderText(settings, 'client.reception_question', language);
  /**
   * Task X: the model writes every text; code only decides. A request stands only on a direct request, a "yes"
   * to the pending offer or an open request. A reply claiming "передано/свяжется" without a request, or an offer
   * that is not allowed now, is regenerated once and then trimmed. A made offer becomes pending_offer.
   */
  const settleOffer = async <T extends Settleable>(first: T, regenerate: (overrides: Partial<ReplyExtras>) => Promise<T>): Promise<T> => {
    let r = first;
    if (r.failure) return r;
    const pending = state.pending_offer;
    if (pending && r.consent === true && !r.request) r.request = { summary: pending.summary, time: pending.time };
    if (pending && r.consent === false) { delete state.pending_offer; state.offer_declined = true; }
    if (r.request) {
      if (extras.openRequest || isDirectRequest(question) || (pending && (r.consent === true || agreement(text)))) return r;
      r.request = null;
    }
    if (r.reply && CLAIMED_PASSED_PATTERN.test(r.reply)) {
      const again = await regenerate({ noPassedClaim: true, mayOffer: mayOffer() });
      if (!again.failure && again.reply) { again.request = null; r = again; }
      if (r.reply && CLAIMED_PASSED_PATTERN.test(r.reply)) r.reply = dropSentences(r.reply, sentence => CLAIMED_PASSED_PATTERN.test(sentence));
    }
    if (offerMade(r) && !mayOffer()) {
      const again = await regenerate({ mayOffer: false });
      if (!again.failure && !again.request && again.reply) r = again;
      if (offerMade(r)) { r.reply = dropSentences(r.reply!, sentence => /\?\s*$/.test(sentence) && OFFER_QUESTION_PATTERN.test(sentence)); r.offered = null; }
    }
    if (offerMade(r) && mayOffer()) state.pending_offer = { summary: r.offered?.summary ?? lastOfferSentence(r.reply!), time: null, topic: r.offered?.summary ?? null, turns_left: config.request_offer_turns };
    return r;
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
    extras.mayOffer = mayOffer();
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
    await rememberName(reception.clientName);
    if (reception.intent === 'sale' || reception.intent === 'support') {
      const agentName = reception.intent === 'sale' ? 'SALE' : 'SUPPORT';
      if (registry.byName(agentName, settings)) {
        conversation.routed_agent = agentName;
        if (sink.mode === 'whatsapp') await assignConversationRoute(db, tenantId, conversation.id, agentName);
      }
      state.intent = reception.intent; state.stage = 'intent_known';
    } else state.stage = 'intent_unknown';
    reception = await settleOffer(reception, overrides => generateReceptionReply(context, question, clarification, knowledgeModel, memory.messages, memory.introduced, language, { ...extras, discovery: closed, ...overrides }));
    if (reception.request) return createRequestNow(reception.request, reception.reply, !!extras.openRequest);
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
    const agentExtras: ReplyExtras = { ...extras, discovery: gate, mayOffer: mayOffer() };
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
      await rememberName(answer.clientName);
      if (gate.mode !== 'closed' && answer.askedQuestion) {
        state.discovery_asked = [...state.discovery_asked, gate.question];
        state.last_question_turn = state.client_turns;
      }
      answer = await settleOffer(answer, overrides => generateKnowledgeReplyResult(context, question, knowledgeModel, agent.systemPrompt, memory.messages, memory.introduced, language, { ...agentExtras, ...overrides }));
      if (answer.request) { agentResult = await createRequestNow(answer.request, answer.reply, !!extras.openRequest); return; }
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
