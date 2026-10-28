import type { DatabaseClient } from '../db/supabase.js';
import type { AIProvider } from '../providers/ai/ai-provider.interface.js';
import type { OwnerSettings } from './owner-settings.service.js';
import type { EmbeddingProvider } from '../providers/embedding/embedding-provider.interface.js';
import { behavior } from './runtime-settings.service.js';
import { renderText } from './templates.service.js';
import { loadContext } from './context.service.js';
import { addOwnerFact } from './business-facts.service.js';
import { clientText, isDeferredAnswer } from '../utils/assistant-text.js';
import { ASSISTANT_NAME_DEFAULT, OWNER_FORWARD_FOLLOW_UP, OWNER_FORWARD_NO_FOLLOW_UP, OWNER_FORWARD_PROMPT, OWNER_REPLY_CLASSIFIER_PROMPT } from '../config/instructions.js';
import { zonedDateTimeFormat } from '../utils/time-zone.js';
import { DEFAULT_TIME_ZONE } from '../config/time-zones.js';

const LANGUAGE_NAMES: Record<string, string> = { he: 'иврит', ru: 'русский', en: 'английский' };
const fill = (template: string, values: Record<string, string>) => template.replace(/\{([a-z_]+)\}/g, (all, key: string) => values[key] ?? all);

/**
 * Z12 (as chef-bot classifyNataliaReply): the owner's reply is the answer or a postponement («позже», «завтра»).
 * Obvious postponements are known without a call; a failed call counts as an answer (as in chef-bot: better to pass a
 * doubtful answer than to leave the client waiting on an API error).
 */
export async function classifyOwnerReply(question: string, answer: string, ai: AIProvider | null | undefined): Promise<'ANSWER' | 'DEFER'> {
  if (isDeferredAnswer(answer)) return 'DEFER';
  if (!ai) return 'ANSWER';
  try {
    const result = await ai.generateReply({ systemPrompt: OWNER_REPLY_CLASSIFIER_PROMPT, userMessage: `Вопрос: «${question.slice(0, 1000)}»\nТекст владельца: «${answer.slice(0, 2000)}»`, generation: { maxOutputTokens: 256 } });
    return /DEFER/i.test(result.text) ? 'DEFER' : 'ANSWER';
  } catch { console.warn('owner_reply_classification_failed'); return 'ANSWER'; }
}

/**
 * Z12 (as chef-bot nataliaReplyFormatter): «Уточнила у {владелец} насчёт {тема}:\n\n«{ответ дословно}»\n\n{реплика}».
 * The owner's words are never rewritten; the model writes only the line before them and (with polish_owner_answer)
 * the short follow-up. Without a model — «{owner} пишет: «…»».
 */
export async function composeOwnerForward(db: DatabaseClient, tenantId: string, input: { question: string; answer: string; language: string }, settings: OwnerSettings, ai?: AIProvider | null): Promise<string> {
  const answer = clientText(input.answer).trim();
  let context: Awaited<ReturnType<typeof loadContext>> | null = null;
  try { context = await loadContext(db, tenantId); } catch { console.warn('owner_forward_context_unavailable'); }
  const ownerName = context?.business?.owner_name?.trim() || '';
  const fallback = () => renderText(settings, 'client.owner_forward_fallback', input.language, { owner_name: ownerName || '—', answer });
  if (!ai || !context) return fallback();
  const followUp = behavior(settings).polish_owner_answer;
  try {
    const prompt = fill(OWNER_FORWARD_PROMPT, { assistant_name: context.assistant?.assistant_name?.trim() || ASSISTANT_NAME_DEFAULT, business_name: context.business?.business_name ?? '',
      owner_name: ownerName, language: LANGUAGE_NAMES[input.language] ?? input.language, follow_up_rule: followUp ? OWNER_FORWARD_FOLLOW_UP : OWNER_FORWARD_NO_FOLLOW_UP });
    const result = await ai.generateReply({ systemPrompt: prompt, userMessage: JSON.stringify({ client_question: input.question.slice(0, 1000), owner_answer: answer.slice(0, 2000) }), generation: { maxOutputTokens: 1024 } });
    const parsed = JSON.parse(result.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) as { intro?: unknown; follow_up?: unknown };
    const intro = typeof parsed.intro === 'string' ? clientText(parsed.intro).replace(/[:：]\s*$/, '').trim() : '';
    if (!intro) return fallback();
    const tail = followUp && typeof parsed.follow_up === 'string' ? clientText(parsed.follow_up).trim() : '';
    return [`${intro}:`, `«${answer}»`, ...(tail ? [tail] : [])].join('\n\n');
  } catch { console.warn('owner_forward_compose_failed'); return fallback(); }
}

/** Z12 (as chef-bot learned-answers.md): the owner's answer becomes an active fact at once, its source names the owner, the date and the question. */
export async function learnOwnerAnswer(db: DatabaseClient, tenantId: string, settings: OwnerSettings, input: { question: string; answer: string }, embedder: EmbeddingProvider | null = null, now = new Date()): Promise<void> {
  const answer = clientText(input.answer).trim(), question = input.question.trim();
  if (!answer) return;
  try {
    const context = await loadContext(db, tenantId);
    const owner = context.business?.owner_name?.trim() || '—', language = behavior(settings).owner_language;
    const date = zonedDateTimeFormat('ru', { day: '2-digit', month: '2-digit', year: 'numeric' }, settings.time_zone ?? DEFAULT_TIME_ZONE).format(now);
    const fact = renderText(settings, 'owner.learned_fact', language, { owner_name: owner, question: question.slice(0, 200), answer: answer.slice(0, 280) }).slice(0, 500);
    const title = renderText(settings, 'owner.learned_title', language, { owner_name: owner, date, question: question.slice(0, 200) });
    await addOwnerFact(db, tenantId, 'other', fact, embedder, { kind: 'owner_answer', title });
  } catch { console.warn('owner_answer_learning_failed', { tenantId }); }
}
