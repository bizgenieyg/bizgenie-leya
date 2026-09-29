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
    const he = input.systemPrompt.includes('Язык этого ответа: he');
    const reply = (value: Record<string, unknown>) => ({ text: JSON.stringify({ unanswered: [], intent: 'sale', ...value }) });
    const mayOffer = input.systemPrompt.includes('Можно предложить клиенту');
    const owner = input.systemPrompt.includes('"Юрия"') ? 'Юрия' : 'Юрий';
    // Task X: the stand-in offers only when the prompt allows it, and marks the offer like the real prompt asks.
    if (mayOffer && /цена подключения|хочу посмотреть|כמה עולה|רוצה לראות/.test(message)) return reply({ reply: he ? `החיבור מ-1500 ₪. ${owner} יראה ב-20 דקות איך זה יעבוד אצלך — לתאם?` : `Подключение от 1500 ₪. ${owner} покажет за 20 минут, как это будет работать у вас — договориться о встрече?`, offered: { summary: 'демо на 20 минут' } });
    if (/по объявлениям|интересно, расскажите|מודעות|מעניין, ספרו/.test(message)) return reply({ reply: he ? 'העוזר יענה מיד לכל מי שכותב מהמודעה, גם בלילה. מה הכי חשוב לך בזה?' : 'Ассистент сразу ответит каждому, кто пишет по объявлению, даже ночью. Что для вас здесь важнее всего?',
      request: { summary: 'Хочет автоматические ответы клиентам', time: null } });
    if (/встреч|запиш|демо|דמו|פגישה/.test(message)) return reply({ reply: he ? `מעולה! ${owner} ייצור איתך קשר לתיאום.` : `Отлично! ${owner} свяжется с вами, чтобы договориться о встрече.`, request: { summary: 'Просит встречу', time: /четверг/.test(message) ? 'четверг' : null } });
    if (/да хочу/.test(message)) return reply({ reply: `Отлично, ${owner} свяжется с вами, чтобы согласовать встречу.`, request: { summary: 'Демо', time: null } });
    if (input.systemPrompt.includes('хотя заявка не создана')) return reply({ reply: 'Расскажите, чем занимается ваш бизнес, — так будет понятно, чем поможет ассистент.' });
    if (/как мне может помочь|чем вы можете помочь/.test(message)) return reply({ reply: 'Ассистент круглосуточно отвечает вашим клиентам по базе вопросов и собирает заявки. Чем занимается ваш бизнес?' });
    if (/не работает|проблем|заказ/.test(message)) return reply({ reply: 'Разберёмся: опишите, что именно не работает.', intent: 'support' });
    if (/юрий\?|ты бот|это владелец/.test(message)) return reply({ reply: 'Я цифровой ассистент BizGenie, отвечу на вопросы об услугах.', intent: 'unknown' });
    if (/эйлат|пластическ/.test(message)) return reply({ reply: null, unanswered: ['Работаете ли с клиниками в Эйлате по субботам?'] });
    if (/надёжн|надежн|заблокир|אמין|יחסמו/.test(message)) return reply({ reply: he ? 'זה עובד דרך WhatsApp רגיל, ויש סיכון קטן לחסימה אם שולחים הודעות המוניות; אנחנו לא עושים את זה. רוצה שאסביר איך נמנעים מזה?' : 'Работает через обычный WhatsApp; риск блокировки есть при массовых рассылках, мы их не делаем. Рассказать, как этого избегаем?' });
    if (/дорого|יקר/.test(message)) return reply({ reply: he ? 'מבין, זו הוצאה. החיבור מ-1500 ₪ ויש תקופת ניסיון. לחשב כמה זמן זה יחסוך לך?' : 'Понимаю, это расход. Подключение от 1500 ₪, и есть пробный период. Посчитать, сколько времени это сэкономит вам?' });
    if (/^нет|^לא/.test(message)) return reply({ reply: he ? 'בסדר. אם יהיו שאלות — כתוב.' : 'Хорошо. Если появятся вопросы — пишите.' });
    if (/не знаю|просто смотрю|לא יודע|רק מסתכל/.test(message)) return reply({ reply: he ? 'הרבה עסקים מפספסים לקוחות שכותבים בערב. העוזר עונה להם מיד לפי המחירון שלך. להראות דוגמה?' : 'Часто бизнес теряет клиентов, которые пишут вечером. Ассистент отвечает им сразу по вашему прайсу. Показать пример?' });
    if (/аренд|השכרת רכב/.test(message)) return reply({ reply: he ? 'להשכרת רכב העוזר יענה על מחיר ורכבים פנויים מיד, גם בלילה. מאיפה מגיעים אליך לקוחות?' : 'Для аренды авто ассистент сразу ответит о цене и свободных машинах, даже ночью. Откуда к вам приходят клиенты?' });
    if (/как это мне поможет|איך זה יעזור/.test(message)) return reply({ reply: he ? 'לקוח ששואל בלילה על רכב יקבל מחיר מיד ולא ילך למתחרה. כמה פניות מגיעות ביום?' : 'Клиент, который ночью спросит про машину, сразу получит цену и не уйдёт к конкуренту. Сколько обращений в день у вас бывает?' });
    const asked = input.systemPrompt.includes('в конце задай своими словами один вопрос');
    if (he) return reply({ reply: `אנחנו בונים עוזרי WhatsApp לעסקים קטנים, החיבור מ-1500 ₪.${asked ? ' כדי להתאים: מאיפה מגיעים הלקוחות?' : ''}`, asked_question: asked });
    // Distinct stock answers per turn: the pipeline rejects a reply repeating one of the last three.
    const turn = (() => { try { return ((JSON.parse(input.userMessage) as { conversationHistory?: Array<{ role: string }> }).conversationHistory ?? []).filter(m => m.role === 'assistant').length; } catch { return 0; } })();
    const stock = ['Делаем WhatsApp-ассистентов для малого бизнеса, подключение от 1500 ₪.', 'Ассистент отвечает вашим клиентам по прайсу сразу, даже вечером и в выходные.', 'Настройка занимает один день: вы рассказываете о бизнесе, мы запускаем.'];
    return reply({ reply: `${stock[turn % stock.length]}${asked ? ' Чтобы подсказать, что подойдёт вам: откуда приходят клиенты?' : ''}`, asked_question: asked });
  } };
}
