import type { DatabaseClient } from '../db/supabase.js';
import type { AIProvider } from '../providers/ai/ai-provider.interface.js';
import type { ConversationMemory } from './context.service.js';
import type { OwnerSettings } from './owner-settings.service.js';
import type { DialogState } from './dialog-state.js';
import { behavior } from './runtime-settings.service.js';
import { activeFacts, factsMarkdown } from './business-facts.service.js';
import { activeBusinessInstruction, activeDemoInstruction, fillPlaceholders, loadCore } from './instructions.service.js';
import { checkedNumbers, hasLabel, labelValue, missingFields, parseLabels, parseRequestValue, unbackedNumbers, unsafeClientText, type ParsedReply } from './instruction-checks.js';
import { agreement, isDirectRequest } from './client-consent.js';
import { CLAIMED_PASSED_PATTERN } from '../config/consent.js';
import { DEMO_EXAMPLE_MARKERS, REQUEST_INTENT_TURNS } from '../config/instructions.js';
import { DEMO_INSTRUCTION_DEFAULTS } from '../config/instruction-defaults.js';
import { renderText } from './templates.service.js';

/**
 * Task Z reply path (reply_engine = 'instruction'): core + business instruction + facts (+ demo business),
 * the conversation as chat turns, the answer as text with labels. No routing, reception, stages or gates.
 * Code runs two checks — the request (consent + required fields) and the numbers — plus the demo marker.
 */
export interface InstructionTurn {
  db: DatabaseClient; tenantId: string; text: string; language: string; settings: OwnerSettings; state: DialogState;
  memory: ConversationMemory[]; model: AIProvider;
  business: { business_name?: string | null; owner_name?: string | null; business_sector?: string | null } | null;
  demo: { key: string | null; turns: number };
}
export type InstructionAction =
  | { kind: 'silent'; reason: string }
  | { kind: 'reply'; text: string }
  | { kind: 'request'; text: string; summary: string; request: { type: string; fields: Record<string, string> } }
  | { kind: 'ask_owner'; text: string; question: string }
  | { kind: 'human'; text: string };
export interface InstructionOutcome { action: InstructionAction; dataRequest: 'delete' | 'access' | null; demo: { key: string | null; turns: number }; offer: string | null; attempts: number; issues: string[] }

const isMarked = (text: string) => DEMO_EXAMPLE_MARKERS.some(marker => text.toLowerCase().includes(marker));
const knownDemo = (key: string | null) => !!key && Object.hasOwn(DEMO_INSTRUCTION_DEFAULTS, key);

export async function answerByInstruction(turn: InstructionTurn): Promise<InstructionOutcome | null> {
  const { db, tenantId, text, language, settings, state } = turn;
  const config = behavior(settings);
  const instructionRaw = await activeBusinessInstruction(db, tenantId);
  if (!instructionRaw) return null; // no active instruction: the tenant keeps the legacy path
  const values = { business_name: turn.business?.business_name, owner_name: turn.business?.owner_name };
  const core = fillPlaceholders(await loadCore(db), values), instruction = fillPlaceholders(instructionRaw, values);
  if (!core.text || !instruction.text) {
    console.error('instruction_placeholder_missing', { tenantId, placeholders: [...core.missing, ...instruction.missing] });
    return { action: { kind: 'silent', reason: 'placeholder' }, dataRequest: null, demo: turn.demo, offer: null, attempts: 0, issues: ['placeholder'] };
  }
  // Demo mode closes by itself after demo_max_turns client turns.
  let demo = turn.demo.key ? { key: turn.demo.key, turns: turn.demo.turns + 1 } : { key: null as string | null, turns: 0 };
  if (demo.key && demo.turns > config.demo_max_turns) demo = { key: null, turns: 0 };
  const demoText = async (key: string | null) => key ? fillPlaceholders(await activeDemoInstruction(db, key) ?? '', values).text : null;
  const facts = factsMarkdown(await activeFacts(db, tenantId), turn.business?.business_sector ?? null);
  const currentDemo = await demoText(demo.key);
  if (isDirectRequest(text)) state.direct_request_turn = state.client_turns;

  const system = (notes: string[]) => [
    core.text, `=== ИНСТРУКЦИЯ БИЗНЕСА ===\n${instruction.text}`, `=== ФАКТЫ ===\n${facts || '(фактов пока нет)'}`,
    ...(demo.key && currentDemo ? [`=== РЕЖИМ ПОКАЗА (${demo.key}) ===\n${currentDemo}`] : []),
    ...(notes.length ? [`=== ИСПРАВЬ ПРОШЛЫЙ ВАРИАНТ ОТВЕТА ===\n${notes.map(n => `- ${n}`).join('\n')}`] : []),
  ].join('\n\n');
  const history = turn.memory.slice(0, -1).map(m => ({ role: m.fromMe ? 'assistant' as const : 'user' as const, text: m.text }));
  const ask = async (notes: string[]): Promise<ParsedReply> => {
    const result = await turn.model.generateReply({ systemPrompt: system(notes), userMessage: text, history });
    const parsed = parseLabels(result.text);
    if (parsed.unknown.length) console.warn('instruction_unknown_labels', { tenantId, labels: parsed.unknown });
    return parsed;
  };

  /** Issues of one variant; each has a note for the regeneration. */
  const review = async (parsed: ParsedReply) => {
    const issues: Array<{ code: string; note: string }> = [];
    if (unsafeClientText(parsed.text)) issues.push({ code: 'unsafe', note: 'В тексте клиенту остались служебные символы или пустой ответ: напиши обычный текст, метки только в конце.' });
    const request = hasLabel(parsed, 'REQUEST') ? parseRequestValue(labelValue(parsed, 'REQUEST')) : null;
    if (hasLabel(parsed, 'REQUEST')) {
      const direct = state.direct_request_turn !== undefined && state.client_turns - state.direct_request_turn <= REQUEST_INTENT_TURNS;
      const consent = direct || (!!state.pending_offer && !!agreement(text));
      const missing = request ? missingFields(request, config.request_required_fields) : ['type'];
      if (!consent) issues.push({ code: 'request_consent', note: 'Клиент не просил и не соглашался на предложение: заявку [[REQUEST]] не ставь, не пиши, что передала или что свяжутся. Если уместно — предложи и спроси согласия.' });
      else if (missing.length) issues.push({ code: 'request_fields', note: `Для заявки не хватает данных: ${missing.join(', ')}. Спроси их у клиента (по одному), заявку пока не ставь и не пиши, что передала.` });
    }
    const newDemo = labelValue(parsed, 'DEMO_START');
    const corpus = demo.key || knownDemo(newDemo) ? (currentDemo ?? await demoText(newDemo) ?? '') : `${facts}\n${instruction.text}`;
    const bad = unbackedNumbers(parsed.text, corpus);
    if (bad.length) issues.push({ code: 'numbers', note: `Этих чисел нет в Фактах и инструкции: ${bad.join(', ')}. Не называй их; если нужного нет — скажи, что уточнишь, и поставь [[ASK_OWNER: вопрос]].` });
    if ((demo.key || knownDemo(newDemo)) && checkedNumbers(parsed.text).length && !state.demo_marked && !isMarked(parsed.text))
      issues.push({ code: 'demo_marker', note: 'В показе при первой цифре скажи, что цены здесь для примера.' });
    return { issues, request };
  };

  let parsed = await ask([]);
  let checked = await review(parsed);
  let attempts = 1;
  if (checked.issues.length) { parsed = await ask(checked.issues.map(i => i.note)); checked = await review(parsed); attempts = 2; }
  const left = new Set(checked.issues.map(i => i.code));
  const ownerName = turn.business?.owner_name ?? '';
  let clientText = parsed.text;
  let request = checked.request;
  if (left.has('unsafe')) clientText = renderText(settings, 'client.instruction_fallback', language);
  if (left.has('request_consent') || left.has('request_fields')) {
    request = null;
    if (CLAIMED_PASSED_PATTERN.test(clientText)) clientText = renderText(settings, 'client.instruction_fallback', language);
  }
  if (left.has('numbers')) {
    return finishOutcome({ kind: 'ask_owner', text: renderText(settings, 'client.ask_owner_fallback', language, { owner_name: ownerName }), question: text.slice(0, 1000) }, parsed, demo, attempts, [...left]);
  }
  if (left.has('demo_marker')) clientText = `${language === 'he' ? 'לדוגמה' : language === 'en' ? 'For example' : 'Для примера'}: ${clientText}`;

  // Labels → actions on the existing mechanisms.
  const start = labelValue(parsed, 'DEMO_START');
  if (knownDemo(start)) demo = { key: start, turns: 0 };
  if (hasLabel(parsed, 'DEMO_END')) demo = { key: null, turns: 0 };
  if (demo.key && (isMarked(clientText) || left.has('demo_marker'))) state.demo_marked = true;
  if (!demo.key) delete state.demo_marked;
  if (request && hasLabel(parsed, 'REQUEST')) {
    const summary = [`${request.type}`, ...Object.entries(request.fields).map(([k, v]) => `${k}: ${v}`)].join('\n');
    return finishOutcome({ kind: 'request', text: clientText, summary, request }, parsed, demo, attempts, [...left]);
  }
  if (hasLabel(parsed, 'HUMAN')) return finishOutcome({ kind: 'human', text: clientText }, parsed, demo, attempts, [...left]);
  if (hasLabel(parsed, 'ASK_OWNER')) return finishOutcome({ kind: 'ask_owner', text: clientText, question: (labelValue(parsed, 'ASK_OWNER') ?? text).slice(0, 1000) }, parsed, demo, attempts, [...left]);
  return finishOutcome({ kind: 'reply', text: clientText }, parsed, demo, attempts, [...left]);
}

function finishOutcome(action: InstructionAction, parsed: ParsedReply, demo: { key: string | null; turns: number }, attempts: number, issues: string[]): InstructionOutcome {
  const data = labelValue(parsed, 'DATA_REQUEST')?.toLowerCase();
  const offer = action.kind === 'reply' && hasLabel(parsed, 'OFFER') ? (labelValue(parsed, 'OFFER') ?? 'предложение') : null;
  return { action, dataRequest: data === 'delete' || data === 'access' ? data : null, demo, offer, attempts, issues };
}
