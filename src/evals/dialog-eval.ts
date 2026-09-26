import { parse } from 'yaml';
import type { AIProvider } from '../providers/ai/ai-provider.interface.js';
import type { DatabaseClient } from '../db/supabase.js';
import type { ConversationMemory } from '../services/context.service.js';
import { simulateCustomerMessage, type SimulationResult } from '../services/simulator.service.js';
import { replyQuestions } from '../services/dialog-state.js';

export interface TurnExpectation {
  text: string; stage?: string; intent?: string; model_calls?: number; max_model_calls?: number;
  must?: string[]; must_not?: string[]; max_questions?: number; request?: boolean; max_sentences?: number;
  no_discovery?: boolean; max_discovery_total?: number;
  /** Days after the start of the scenario at which this message is sent (e.g. a greeting on another day). */
  after_days?: number;
}
export interface Scenario { id: string; title: string; history?: Array<{ from: 'client' | 'business'; text: string }>; profile?: string; turns: TurnExpectation[] }
export interface CheckResult { scenario: string; turn: number; check: string; kind: 'route' | 'text'; pass: boolean; detail?: string }

export function loadScenarios(source: string): Scenario[] {
  const data = parse(source) as { scenarios?: Scenario[] };
  if (!Array.isArray(data?.scenarios) || !data.scenarios.length) throw new Error('evals: no scenarios');
  return data.scenarios;
}

const sentences = (text: string) => text.split(/(?<=[.!?…])\s+/).map(s => s.trim()).filter(Boolean).length;
const regex = (pattern: string) => new RegExp(pattern, 'iu');

/** Route/stage checks must pass 100 %; text checks (regex, counts) are compared against a threshold. */
export function checkTurn(scenario: string, turn: number, expected: TurnExpectation, result: SimulationResult, modelCalls: number, discoveryTotal: number): CheckResult[] {
  const out: CheckResult[] = [];
  const push = (check: string, kind: CheckResult['kind'], pass: boolean, detail?: string) => out.push({ scenario, turn, check, kind, pass, ...(detail ? { detail } : {}) });
  const reply = result.reply ?? '';
  if (expected.stage) push(`stage=${expected.stage}`, 'route', result.trace?.stage === expected.stage, result.trace?.stage);
  if (expected.intent) push(`intent=${expected.intent}`, 'route', result.trace?.intent === expected.intent, result.trace?.intent);
  if (expected.model_calls !== undefined) push(`model_calls=${expected.model_calls}`, 'route', modelCalls === expected.model_calls, String(modelCalls));
  if (expected.max_model_calls !== undefined) push(`model_calls≤${expected.max_model_calls}`, 'route', modelCalls <= expected.max_model_calls, String(modelCalls));
  if (expected.request !== undefined) push(`request=${expected.request}`, 'route', (result.trace?.request ?? false) === expected.request);
  if (expected.no_discovery) push('no discovery question', 'route', (result.trace?.discovery_asked.length ?? 0) === 0, String(result.trace?.discovery_asked.length));
  if (expected.max_discovery_total !== undefined) push(`discovery≤${expected.max_discovery_total}`, 'route', discoveryTotal <= expected.max_discovery_total, String(discoveryTotal));
  for (const pattern of expected.must ?? []) push(`must /${pattern}/`, 'text', regex(pattern).test(reply), reply.slice(0, 120));
  for (const pattern of expected.must_not ?? []) push(`must_not /${pattern}/`, 'text', !regex(pattern).test(reply), reply.slice(0, 120));
  if (expected.max_questions !== undefined) push(`questions≤${expected.max_questions}`, 'text', replyQuestions(reply).length <= expected.max_questions, String(replyQuestions(reply).length));
  if (expected.max_sentences !== undefined) push(`sentences≤${expected.max_sentences}`, 'text', sentences(reply) <= expected.max_sentences, String(sentences(reply)));
  return out;
}

/** Counts model calls of one pipeline turn. */
export function countingModel(ai: AIProvider | null): { model: AIProvider | null; take(): number } {
  let calls = 0;
  if (!ai) return { model: null, take: () => { const n = calls; calls = 0; return n; } };
  return { model: { async generateReply(input) { calls++; return ai.generateReply(input); } }, take: () => { const n = calls; calls = 0; return n; } };
}

export interface EvalSummary { results: CheckResult[]; modelCalls: number; inputTokens: number; outputTokens: number; routePass: number; routeTotal: number; textPass: number; textTotal: number }

/**
 * Runs every scenario `runs` times through the simulator pipeline on the real model, each run in a
 * fresh temporary simulator session that is deleted afterwards.
 */
export async function runDialogEval(db: DatabaseClient, tenantId: string, scenarios: Scenario[], ai: AIProvider, runs: number, log: (line: string) => void = () => undefined): Promise<EvalSummary> {
  const results: CheckResult[] = [];
  let totalCalls = 0, inputTokens = 0, outputTokens = 0;
  const metered: AIProvider = { async generateReply(input) { const r = await ai.generateReply(input); inputTokens += Number(r.usage?.input_tokens ?? 0); outputTokens += Number(r.usage?.output_tokens ?? 0); return r; } };
  for (let run = 1; run <= runs; run++) for (const scenario of scenarios) {
    const session = crypto.randomUUID();
    const counter = countingModel(metered);
    const history: ConversationMemory[] | undefined = scenario.history?.map((item, i) => ({ fromMe: item.from === 'business', text: item.text, createdAt: new Date(Date.now() - (scenario.history!.length - i) * 86_400_000).toISOString() }));
    const start = Date.now();
    try {
      for (const [index, turn] of scenario.turns.entries()) {
        const now = new Date(start + (turn.after_days ?? 0) * 86_400_000 + index * 60_000);
        const result = await simulateCustomerMessage(db, tenantId, session, turn.text, counter.model, { now, evaluation: { ...(history ? { history } : {}), ...(scenario.profile ? { profile: scenario.profile } : {}) } });
        const calls = counter.take(); totalCalls += calls;
        const checks = checkTurn(scenario.id, index + 1, turn, result, calls, result.trace?.discovery_asked.length ?? 0);
        results.push(...checks);
        log(`run ${run} · ${scenario.id} · ${index + 1}: ${checks.every(c => c.pass) ? 'PASS' : 'FAIL'} · calls ${calls} · ${JSON.stringify(result.reply ?? '').slice(0, 140)}`);
      }
    } finally {
      await db.from('simulator_messages').delete().eq('tenant_id', tenantId).eq('session_id', session);
      await db.from('simulator_sessions').delete().eq('tenant_id', tenantId).eq('id', session);
    }
  }
  const route = results.filter(r => r.kind === 'route'), text = results.filter(r => r.kind === 'text');
  return { results, modelCalls: totalCalls, inputTokens, outputTokens,
    routePass: route.filter(r => r.pass).length, routeTotal: route.length, textPass: text.filter(r => r.pass).length, textTotal: text.length };
}

export function formatReport(summary: EvalSummary, prices: { inputPerMillion: number; outputPerMillion: number }): string {
  const rows = summary.results.map(r => `| ${r.scenario} | ${r.turn} | ${r.check} | ${r.pass ? 'PASS' : 'FAIL'} | ${(r.detail ?? '').replace(/\|/g, '/').slice(0, 80)} |`);
  const routeShare = summary.routeTotal ? summary.routePass / summary.routeTotal : 1, textShare = summary.textTotal ? summary.textPass / summary.textTotal : 1;
  const cost = summary.inputTokens / 1e6 * prices.inputPerMillion + summary.outputTokens / 1e6 * prices.outputPerMillion;
  return ['| Сценарий | Ход | Проверка | Итог | Детали |', '|---|---|---|---|---|', ...rows, '',
    `Маршрут и этапы: ${summary.routePass}/${summary.routeTotal} (${(routeShare * 100).toFixed(1)} %, порог 100 %) — ${routeShare === 1 ? 'PASS' : 'FAIL'}`,
    `Текстовые проверки: ${summary.textPass}/${summary.textTotal} (${(textShare * 100).toFixed(1)} %, порог 90 %) — ${textShare >= 0.9 ? 'PASS' : 'FAIL'}`,
    `Вызовов модели: ${summary.modelCalls}; токены: вход ${summary.inputTokens}, выход ${summary.outputTokens}; оценка стоимости прогона ≈ $${cost.toFixed(4)}`].join('\n');
}

/** Accept a full tenant UUID or a unique prefix ("ef795be3"); ambiguity or no match is an error listing candidates. */
export function resolveTenant(input: string, tenants: Array<{ id: string; name?: string | null }>): string {
  const wanted = input.trim().toLowerCase();
  if (!/^[0-9a-f-]{4,36}$/.test(wanted)) throw new Error('Tenant must be a UUID or its hex prefix');
  const matches = tenants.filter(t => t.id.toLowerCase().startsWith(wanted));
  if (matches.length === 1) return matches[0]!.id;
  const list = (matches.length ? matches : tenants).slice(0, 20).map(t => `  ${t.id}${t.name ? ` (${t.name})` : ''}`).join('\n');
  throw new Error(matches.length ? `Tenant prefix "${input}" is ambiguous:\n${list}` : `No tenant starts with "${input}". Known tenants:\n${list}`);
}

/**
 * Offline check of the scenarios (no --live): a deterministic stand-in model that answers in the
 * structured formats of the real prompts. It validates the file, the harness and the code paths
 * (templates, zero-call greetings, gates), not the quality of real replies.
 */
export function scriptedModel(): AIProvider {
  return { async generateReply(input) {
    const message = (() => { try { return String((JSON.parse(input.userMessage) as { customerMessage?: unknown }).customerMessage ?? ''); } catch { return ''; } })().toLowerCase();
    if (input.systemPrompt.includes('прошлая переписка')) return { text: JSON.stringify({ intent: 'sale', facts: [{ fact: 'заказывал лендинг для кейтеринга', answers_question: null }, { fact: 'имя — Марина', answers_question: null }] }) };
    if (input.systemPrompt.includes('классификатор намерений')) return { text: '{"agent":"UNKNOWN","confidence":0.2}' };
    if (/встреч|запиш|демо/.test(message)) return { text: JSON.stringify({ reply: null, unanswered: [], request: { summary: 'Просит встречу', time: /четверг/.test(message) ? 'четверг' : null }, intent: 'sale' }) };
    if (/не работает|проблем|заказ/.test(message)) return { text: JSON.stringify({ reply: 'Разберёмся: опишите, что именно не работает.', unanswered: [], intent: 'support' }) };
    if (/юрий\?|ты бот|это владелец/.test(message)) return { text: JSON.stringify({ reply: 'Я ассистент Юрия, отвечу на вопросы о его услугах.', unanswered: [], intent: 'unknown' }) };
    if (/эйлат|пластическ/.test(message)) return { text: JSON.stringify({ reply: null, unanswered: ['Работаете ли с клиниками в Эйлате по субботам?'], intent: 'sale' }) };
    const asked = input.systemPrompt.includes('в конце задай своими словами один вопрос');
    return { text: JSON.stringify({ reply: `Делаем WhatsApp-ассистентов для малого бизнеса, подключение от 1500 ₪.${asked ? ' Чтобы подсказать, что подойдёт вам: откуда приходят клиенты?' : ''}`, unanswered: [], intent: 'sale', asked_question: asked }) };
  } };
}
