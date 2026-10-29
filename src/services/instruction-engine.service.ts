import type { DatabaseClient } from '../db/supabase.js';
import type { AIProvider } from '../providers/ai/ai-provider.interface.js';
import type { ConversationMemory } from './context.service.js';
import type { OwnerSettings } from './owner-settings.service.js';
import type { DialogState } from './dialog-state.js';
import { behavior } from './runtime-settings.service.js';
import { activeFacts, factsMarkdown } from './business-facts.service.js';
import { activeInstructionFor, resolveTemplate, activeDemoInstruction, fillPlaceholders, loadCore } from './instructions.service.js';
import { hasLabel, labelValue, labelValues, parseLabels, parseRequestValue, type ParsedReply } from './instruction-checks.js';
import { ASSISTANT_NAME_DEFAULT, PROMPT_BLOCKS, WEEKDAYS_RU } from '../config/instructions.js';
import { CORE_LANGUAGE_DEFAULTS } from '../config/instruction-defaults.js';
import { ROLE_HEADINGS, type ReplyRole } from '../config/roles.js';
import { activeRules, rulesBlock } from './owner-rules.service.js';
import { chooseRole } from './reply-role.service.js';
import { isWithinQuietHours, nextQuietHoursEnd } from './escalation.service.js';
import { zonedDateTimeFormat, localTime } from '../utils/time-zone.js';
import { DEFAULT_TIME_ZONE } from '../config/time-zones.js';

/**
 * Task Z reply path (reply_engine = 'instruction'): core + business instruction (common part + the section of the
 * dialog's role) + rules + facts (+ demo business) + what is known about this moment (date, name, open questions to
 * the owner, quiet hours, voice). Z12 (as chef-bot): the model's answer goes out as it is — code only cuts the labels
 * and service characters; no checks, no regeneration, no fallback text.
 */
export interface InstructionTurn {
  db: DatabaseClient; tenantId: string; text: string; language: string; settings: OwnerSettings; state: DialogState;
  memory: ConversationMemory[]; model: AIProvider;
  business: { business_name?: string | null; owner_name?: string | null; business_sector?: string | null } | null;
  /** Z8: the name the owner gave the assistant; empty → ASSISTANT_NAME_DEFAULT. */
  assistantName?: string | null | undefined;
  demo: { key: string | null; turns: number };
  /** Z12: the dialog's role (SALES by default), the client's WhatsApp name, questions still waiting for the owner. */
  role?: ReplyRole;
  /** Z12: the short role classifier; called only when the instruction has role sections and keywords did not decide. */
  roleClassifier?: AIProvider | null;
  clientName?: string | null;
  openQuestions?: string[];
  voice?: boolean;
  now?: Date;
}
export type InstructionAction =
  | { kind: 'silent'; reason: string }
  | { kind: 'reply'; text: string }
  | { kind: 'request'; text: string; summary: string; card: string | null; request: { type: string; fields: Record<string, string> } }
  | { kind: 'ask_owner'; text: string; questions: string[] }
  | { kind: 'human'; text: string };
export interface InstructionOutcome { action: InstructionAction; dataRequest: 'delete' | 'access' | null; demo: { key: string | null; turns: number }; offer: string | null; attempts: number; issues: string[] }

/** Language of the client's last message, as the prompt names it (ru names: the core is Russian). */
const LANGUAGE_NAMES: Record<string, string> = { he: 'иврит', ru: 'русский', en: 'английский' };
const fill = (template: string, values: Record<string, string>) => template.replace(/\{([a-z_]+)\}/g, (all, key: string) => values[key] ?? all);
/** Service characters that never reach a client (labels are already cut). */
const cleanClientText = (text: string) => text.replace(/\{[^{}\n]*\}|<[^<>\n]*>/g, '').replace(/\[\[|\]\]|[<>{}]/g, '').replace(/\b(undefined|null)\b/g, '')
  .replace(/[ \t]{2,}/g, ' ').replace(/ +([.,!?])/g, '$1').replace(/[ \t]+\n/g, '\n').trim();

/** Z12: the common part of the instruction + the section of this role; no role headings — the whole text. */
export const hasRoleSections = (text: string) => text.split('\n').some(line => ROLE_HEADINGS.SALES.test(line.trim()) || ROLE_HEADINGS.SUPPORT.test(line.trim()));
export function instructionForRole(text: string, role: ReplyRole): string {
  const lines = text.split('\n');
  if (!hasRoleSections(text)) return text;
  let current: ReplyRole | 'COMMON' = 'COMMON';
  const kept: string[] = [];
  for (const line of lines) {
    const heading = (['SALES', 'SUPPORT', 'COMMON'] as const).find(key => ROLE_HEADINGS[key].test(line.trim()));
    if (heading) { current = heading; continue; }
    if (current === 'COMMON' || current === role) kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Z12 (as chef-bot): date, known name, open questions, quiet hours, voice — one block of the system prompt. */
export function momentBlock(turn: Pick<InstructionTurn, 'settings' | 'clientName' | 'openQuestions' | 'voice' | 'now'>, ownerName: string): string {
  const now = turn.now ?? new Date(), zone = turn.settings.time_zone ?? DEFAULT_TIME_ZONE;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(zonedDateTimeFormat('en-US', { weekday: 'short' }, zone).format(now));
  const date = zonedDateTimeFormat('ru', { day: 'numeric', month: 'long', year: 'numeric' }, zone).format(now);
  const owner = ownerName || 'владелец';
  const lines = [fill(PROMPT_BLOCKS.today, { weekday: WEEKDAYS_RU[weekday] ?? '', date })];
  const name = turn.clientName?.trim();
  if (name) lines.push(fill(PROMPT_BLOCKS.knownName, { name: name.slice(0, 60) }));
  const open = (turn.openQuestions ?? []).filter(Boolean);
  lines.push(open.length ? fill(PROMPT_BLOCKS.openQuestions, { owner_name: owner, items: open.map(q => `- «${q.slice(0, 300)}»`).join('\n') }) : fill(PROMPT_BLOCKS.noOpenQuestions, { owner_name: owner }));
  lines.push(fill(PROMPT_BLOCKS.openQuestionsRule, { owner_name: owner }));
  if (isWithinQuietHours(turn.settings, now)) {
    const until = nextQuietHoursEnd(turn.settings, now);
    if (until) lines.push(fill(PROMPT_BLOCKS.quietHours, { owner_name: owner, until: localTime(until, zone, 'ru') }));
  }
  if (turn.voice) lines.push(PROMPT_BLOCKS.voice);
  return lines.join('\n\n');
}

export async function answerByInstruction(turn: InstructionTurn): Promise<InstructionOutcome | null> {
  const { db, tenantId, text, language, settings } = turn;
  const config = behavior(settings);
  // Z6: its own instruction, else the template of its deal type (setting or sector), else 'general'.
  const active = await activeInstructionFor(db, tenantId, resolveTemplate(config.instruction_template, turn.business?.business_sector));
  if (!active) return null; // nothing published: the tenant keeps the legacy path
  const values = { business_name: turn.business?.business_name, owner_name: turn.business?.owner_name, assistant_name: turn.assistantName?.trim() || ASSISTANT_NAME_DEFAULT };
  const role = turn.role ?? (hasRoleSections(active.text) ? await chooseRole(text, turn.memory, turn.state, turn.roleClassifier ?? null) : 'SALES');
  const core = fillPlaceholders(await loadCore(db), values), instruction = fillPlaceholders(instructionForRole(active.text, role), values);
  if (!core.text || !instruction.text) {
    console.error('instruction_placeholder_missing', { tenantId, placeholders: [...core.missing, ...instruction.missing] });
    return { action: { kind: 'silent', reason: 'placeholder' }, dataRequest: null, demo: turn.demo, offer: null, attempts: 0, issues: ['placeholder'] };
  }
  // Demo mode closes by itself after demo_max_turns client turns.
  let demo = turn.demo.key ? { key: turn.demo.key, turns: turn.demo.turns + 1 } : { key: null as string | null, turns: 0 };
  if (demo.key && demo.turns > config.demo_max_turns) demo = { key: null, turns: 0 };
  let demoText = demo.key ? fillPlaceholders(await activeDemoInstruction(db, demo.key) ?? '', values).text : null;
  const facts = factsMarkdown(await activeFacts(db, tenantId), turn.business?.business_sector ?? null);
  const rules = rulesBlock(await activeRules(db, tenantId));
  const ownerName = turn.business?.owner_name?.trim() ?? '';
  const languageBlock = CORE_LANGUAGE_DEFAULTS[language];

  const coreText = core.text, instructionText = instruction.text;
  const systemPrompt = () => [
    languageBlock ? `${coreText.trimEnd()}\n${languageBlock.trim()}` : coreText,
    `=== ИНСТРУКЦИЯ БИЗНЕСА ===\n${instructionText}`,
    // Z11: the owner's rules — after the instruction (they win over it), before the facts.
    ...(rules ? [`=== ПРАВИЛА ЭТОГО БИЗНЕСА ===\n${rules}`] : []),
    `=== ФАКТЫ ===\n${facts || '(фактов пока нет)'}`,
    ...(demo.key && demoText ? [`=== РЕЖИМ ПОКАЗА (${demo.key}) ===\n${demoText}`] : []),
    `=== СЕЙЧАС ===\n${momentBlock(turn, ownerName)}`,
    ...(LANGUAGE_NAMES[language] ? [`=== ЯЗЫК ОТВЕТА ===\nПоследнее сообщение клиента — ${LANGUAGE_NAMES[language]}. Весь ответ — на этом языке.`] : []),
  ].join('\n\n');
  const history = turn.memory.slice(0, -1).map(m => ({ role: m.fromMe ? 'assistant' as const : 'user' as const, text: m.text }));
  const ask = async () => parseLabels((await turn.model.generateReply({ systemPrompt: systemPrompt(), userMessage: text, history,
    generation: { maxOutputTokens: config.reply_max_output_tokens, retryMaxOutputTokens: config.reply_retry_max_output_tokens, thinkingLevels: config.reply_thinking_levels,
      timeoutMs: config.reply_timeout_ms, attemptTimeoutMs: config.reply_attempt_timeout_ms, retryDelayMs: config.reply_retry_delay_ms } })).text);
  let parsed = await ask();
  // Z12 review (eval B9): the answer that starts a demo was written without the demo business (the mode was not on):
  // it is written once more with the demo text, so prices and terms come from it. Context, not a check of the answer.
  const starting = labelValue(parsed, 'DEMO_START');
  if (!demo.key && starting && /^[a-z][a-z0-9_]{1,39}$/.test(starting) && !hasLabel(parsed, 'DEMO_END')) {
    const text = fillPlaceholders(await activeDemoInstruction(db, starting) ?? '', values).text;
    if (text) { demo = { key: starting, turns: 0 }; demoText = text; parsed = await ask(); if (!hasLabel(parsed, 'DEMO_START') && !hasLabel(parsed, 'DEMO_END')) parsed.labels.push({ name: 'DEMO_START', value: starting }); }
  }
  if (parsed.unknown.length) console.warn('instruction_unknown_labels', { tenantId, labels: parsed.unknown });
  const clientText = cleanClientText(parsed.text);
  // Only labels and no words: nothing the client can read — the same short apology as a model failure.
  if (!clientText) throw new Error('Empty reply');

  // Labels → actions on the existing mechanisms.
  const start = labelValue(parsed, 'DEMO_START');
  if (hasLabel(parsed, 'DEMO_START')) {
    // Without a valid demo key the mode is not switched on (Z2): only the label name and the key shape are logged.
    const known = !!start && /^[a-z][a-z0-9_]{1,39}$/.test(start) && (await activeDemoInstruction(db, start)) !== null;
    if (known) demo = { key: start, turns: 0 };
    else console.warn('instruction_demo_unknown_key', { tenantId, label: 'DEMO_START', key: start && /^[a-z0-9_]{1,40}$/.test(start) ? start : null });
  }
  if (hasLabel(parsed, 'DEMO_END')) demo = { key: null, turns: 0 };
  if (hasLabel(parsed, 'REQUEST')) {
    const request = parseRequestValue(labelValue(parsed, 'REQUEST')) ?? { type: 'request', fields: {} };
    const summary = [`${request.type}`, ...Object.entries(request.fields).map(([k, v]) => `${k}: ${v}`)].join('\n');
    return finishOutcome({ kind: 'request', text: clientText, summary, card: parsed.card ?? null, request }, parsed, demo);
  }
  if (hasLabel(parsed, 'HUMAN')) return finishOutcome({ kind: 'human', text: clientText }, parsed, demo);
  const questions = labelValues(parsed, 'ASK_OWNER').map(q => q.slice(0, 1000));
  if (hasLabel(parsed, 'ASK_OWNER')) return finishOutcome({ kind: 'ask_owner', text: clientText, questions: questions.length ? questions : [text.slice(0, 1000)] }, parsed, demo);
  return finishOutcome({ kind: 'reply', text: clientText }, parsed, demo);
}

function finishOutcome(action: InstructionAction, parsed: ParsedReply, demo: { key: string | null; turns: number }): InstructionOutcome {
  const data = labelValue(parsed, 'DATA_REQUEST')?.toLowerCase();
  const offer = action.kind === 'reply' && hasLabel(parsed, 'OFFER') ? (labelValue(parsed, 'OFFER') ?? 'предложение') : null;
  return { action, dataRequest: data === 'delete' || data === 'access' ? data : null, demo, offer, attempts: 1, issues: [] };
}
