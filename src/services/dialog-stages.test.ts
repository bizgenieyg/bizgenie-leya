import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { recordModelOutcome, resetModelHealth } from './model-health.service.js';
import { renderGreeting } from './templates.service.js';
import { discoveryGate, normalizeDialogState, asksListedQuestion, untilFirstQuestion } from './dialog-state.js';
import { loadScenarios, checkTurn } from '../evals/dialog-eval.js';

test('model outage alert: 3 failures in a row or ≥50 % of ≥3 calls in 10 min; recovery once', () => {
  const alerts: string[] = [];
  resetModelHealth(async (kind, text) => { alerts.push(`${kind}:${text}`); return true; });
  const t = 1_000_000;
  recordModelOutcome(false, { reason: 'http_403', httpStatus: 403, providerStatus: 'PERMISSION_DENIED' }, t);
  recordModelOutcome(false, { reason: 'http_403', httpStatus: 403, providerStatus: 'PERMISSION_DENIED' }, t + 1);
  assert.equal(alerts.length, 0);
  recordModelOutcome(false, { reason: 'http_403', httpStatus: 403, providerStatus: 'PERMISSION_DENIED' }, t + 2);
  assert.deepEqual(alerts, ['model_down:⚠️ Модель не отвечает: 403 PERMISSION_DENIED. Клиенты получают ответ-заглушку.']);
  recordModelOutcome(false, { reason: 'http_403' }, t + 3);
  assert.equal(alerts.length, 1, 'no repeat while down');
  recordModelOutcome(true, undefined, t + 4);
  assert.equal(alerts[1], 'model_recovered:✅ Модель снова отвечает.');
  resetModelHealth(async (kind) => { alerts.push(kind); return true; });
  recordModelOutcome(true, undefined, t); recordModelOutcome(false, { reason: 'timeout' }, t + 1); recordModelOutcome(true, undefined, t + 2); recordModelOutcome(false, { reason: 'timeout' }, t + 3);
  assert.equal(alerts.at(-1), 'model_down', '2 of 4 calls failed within the window');
  resetModelHealth();
});

test('greeting templates: defaults per language, empty substitutions never break the phrase', () => {
  const values = { assistant_name: 'Гоша', owner_name: 'Юрия', business_name: 'BizGenie' };
  assert.equal(renderGreeting(undefined, 'client.greeting', 'ru', values), 'Здравствуйте! Это Гоша, ассистент Юрия. Чем могу помочь?');
  assert.equal(renderGreeting(undefined, 'client.greeting', 'ru', { owner_name: 'Юрия' }), 'Здравствуйте! Чем могу помочь?');
  assert.equal(renderGreeting(undefined, 'client.greeting', 'en', { assistant_name: 'Leya', owner_name: 'Yuri' }), "Hi! This is Leya, Yuri's assistant. How can I help?");
  assert.equal(renderGreeting(undefined, 'client.greeting', 'he', { assistant_name: 'לאה', owner_name: 'יורי' }), 'היי! כאן לאה, בשם יורי. במה אפשר לעזור?');
  assert.equal(renderGreeting(undefined, 'client.greeting_known', 'ru', { client_first_name: 'Марина' }), 'Здравствуйте, Марина! Чем могу помочь?');
  assert.equal(renderGreeting(undefined, 'client.greeting_known', 'ru', {}), 'Здравствуйте! Чем могу помочь?');
  assert.equal(renderGreeting(undefined, 'client.greeting_known', 'en', { client_first_name: 'Dana' }), 'Hi Dana! How can I help?');
  assert.equal(renderGreeting({ templates: { 'client.greeting': { ru: 'Привет! Я {assistant_name}.' } } } as never, 'client.greeting', 'ru', { assistant_name: 'Гоша' }), 'Привет! Я Гоша.');
});

test('discovery gate: sale only, from turn 2 (situational on turn 1), ≥2 turns apart, at most 3, never repeats', () => {
  const qs = ['Чем занимается бизнес и сколько в нём человек?', 'Откуда приходят клиенты?', 'Что отнимает больше всего времени?', 'Какими системами пользуетесь?'];
  const s = (v: Record<string, unknown>) => normalizeDialogState({ intent: 'sale', stage: 'intent_known', ...v });
  assert.deepEqual(discoveryGate(s({ intent: 'support', client_turns: 3 }), qs, true), { mode: 'closed' });
  assert.deepEqual(discoveryGate(s({ client_turns: 3 }), qs, false), { mode: 'closed' });
  assert.deepEqual(discoveryGate(s({ client_turns: 1 }), qs, true), { mode: 'situational', question: qs[0] });
  assert.deepEqual(discoveryGate(s({ client_turns: 2 }), qs, true), { mode: 'open', question: qs[0] });
  assert.deepEqual(discoveryGate(s({ client_turns: 3, discovery_asked: [qs[0]], last_question_turn: 2 }), qs, true), { mode: 'closed' });
  assert.deepEqual(discoveryGate(s({ client_turns: 4, discovery_asked: [qs[0]], last_question_turn: 2 }), qs, true), { mode: 'open', question: qs[1] });
  assert.deepEqual(discoveryGate(s({ client_turns: 9, discovery_asked: qs.slice(0, 3), last_question_turn: 6 }), qs, true), { mode: 'closed' });
  assert.equal(asksListedQuestion('Отлично. Сколько в нём человек и чем занимается бизнес?', qs), true);
  assert.equal(asksListedQuestion('Что для вас сейчас актуально?', qs), false);
  assert.equal(untilFirstQuestion('Стоит от 1500 ₪. Для какого бизнеса? И сколько сотрудников?'), 'Стоит от 1500 ₪. Для какого бизнеса?');
});

test('evals file: at least 14 scenarios incl. every required case; checks separate route and text', () => {
  const scenarios = loadScenarios(readFileSync('evals/dialogs.yaml', 'utf8'));
  assert.ok(scenarios.length >= 14);
  for (const id of ['greeting-ru', 'greeting-he', 'evening-then-about', 'greeting-plus-price', 'salon-discovery', 'thanks-ok-thumb', 'support-broken-order', 'sale-then-support', 'meeting-thursday', 'sector-and-size-given', 'out-of-base', 'three-substantive', 'is-it-yuri', 'known-by-history'])
    assert.ok(scenarios.some(s => s.id === id), id);
  assert.ok(scenarios.find(s => s.id === 'known-by-history')!.history!.length > 0);
  const checks = checkTurn('x', 1, { text: 'привет', stage: 'intent_unknown', model_calls: 0, must: ['помочь'], max_questions: 1 },
    { reply: 'Здравствуйте! Чем могу помочь?', outcome: 'answered', trace: { stage: 'intent_unknown', intent: 'unknown', request: false, client_turns: 0, discovery_asked: [] } }, 0, 0);
  assert.ok(checks.every(c => c.pass));
  assert.deepEqual(checks.map(c => c.kind), ['route', 'route', 'text', 'text']);
});
