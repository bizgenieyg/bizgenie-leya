/**
 * Conversation flow is decided by code; the model only writes text. The state lives in
 * conversations.dialog_state (simulator: simulator_sessions.dialog_state).
 */
export type DialogStage = 'greeting' | 'intent_unknown' | 'intent_known' | 'request';
export type DialogIntent = 'sale' | 'support' | 'unknown';
export interface DialogState {
  stage: DialogStage;
  intent: DialogIntent;
  client_turns: number;
  discovery_asked: string[];
  last_question_turn: number | null;
  history_analyzed?: boolean;
}

export const DISCOVERY_MAX_ASKED = 3;
export const DISCOVERY_MIN_TURN = 2;
export const DISCOVERY_MIN_GAP = 2;

export function normalizeDialogState(value: unknown): DialogState {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const stage = ['greeting', 'intent_unknown', 'intent_known', 'request'].includes(String(v.stage)) ? v.stage as DialogStage : 'greeting';
  const intent = ['sale', 'support', 'unknown'].includes(String(v.intent)) ? v.intent as DialogIntent : 'unknown';
  return {
    stage, intent,
    client_turns: Number.isSafeInteger(v.client_turns) && Number(v.client_turns) >= 0 ? Number(v.client_turns) : 0,
    discovery_asked: Array.isArray(v.discovery_asked) ? v.discovery_asked.filter((q): q is string => typeof q === 'string').slice(0, 20) : [],
    last_question_turn: Number.isSafeInteger(v.last_question_turn) ? Number(v.last_question_turn) : null,
    ...(v.history_analyzed === true ? { history_analyzed: true } : {}),
  };
}

export const agentIntent = (agent: string | null | undefined): DialogIntent =>
  agent === 'SALE' ? 'sale' : agent === 'SUPPORT' ? 'support' : 'unknown';

export type DiscoveryGate = { mode: 'closed' } | { mode: 'open' | 'situational'; question: string };

/**
 * Needs-discovery gate: sale intent, a substantive message, fewer than DISCOVERY_MAX_ASKED questions
 * asked, at least DISCOVERY_MIN_GAP client turns since the last one. From turn DISCOVERY_MIN_TURN the
 * question is offered normally; on the first substantive turn only if the client described a situation.
 * One question at a time, never one already asked or already answered (`known`).
 */
export function discoveryGate(state: DialogState, questions: string[], substantive: boolean): DiscoveryGate {
  if (state.intent !== 'sale' || !substantive || state.discovery_asked.length >= DISCOVERY_MAX_ASKED) return { mode: 'closed' };
  if (state.last_question_turn !== null && state.client_turns - state.last_question_turn < DISCOVERY_MIN_GAP) return { mode: 'closed' };
  const question = questions.find(q => !state.discovery_asked.includes(q));
  if (!question) return { mode: 'closed' };
  return { mode: state.client_turns >= DISCOVERY_MIN_TURN ? 'open' : 'situational', question };
}

const norm = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const stems = (text: string) => new Set(norm(text).split(' ').filter(w => w.length > 3).map(w => w.slice(0, 5)));
/** Questions in a reply ("…?" sentences). */
export const replyQuestions = (reply: string) => reply.match(/[^.!?\n]*\?/g)?.map(q => q.trim()).filter(Boolean) ?? [];
/** True when a reply sentence asks one of the listed discovery questions (≥ 2 and ≥ half of its word stems). */
export function asksListedQuestion(reply: string, questions: string[]): boolean {
  return replyQuestions(reply).some(asked => {
    const a = stems(asked);
    return questions.some(q => { const s = stems(q); if (!s.size) return false; let hit = 0; for (const w of s) if (a.has(w)) hit++; return hit >= 2 && hit / s.size >= 0.5; });
  });
}
/** Keep the text up to and including the first question. */
export function untilFirstQuestion(reply: string): string {
  const index = reply.indexOf('?');
  return index < 0 ? reply : reply.slice(0, index + 1).trim();
}
