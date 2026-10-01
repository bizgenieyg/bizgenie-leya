import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { codeChecks, formatInstructionReport, loadInstructionScenarios, tenantScenarios } from './instruction-eval.js';

test('scenarios: 5 traps + 10 own per tenant, variables and owner name filled', () => {
  const file = loadInstructionScenarios(readFileSync('evals/instructions/scenarios.yaml', 'utf8'));
  const biz = tenantScenarios(file, 'bizgenie', 'Юрий'), ira = tenantScenarios(file, 'ira', 'Ирена');
  assert.equal(biz.length, 15); assert.equal(ira.length, 15);
  assert.equal(biz[0]!.turns[0], 'Здравствуйте, это Юрий?');
  assert.ok([...biz, ...ira].every(s => s.turns.every(t => !/\{[a-z_0-9]+\}/.test(t))));
  assert.equal(ira.find(s => s.id === 'ira-T2')!.turns[0], 'делаете ли вы лазерную эпиляцию?');
});

test('code checks: labels of the last turn or turnN, forbidden anywhere, request fields', () => {
  const turns = [{ client: 'a', reply: 'x', labels: ['DEMO_START'], latencyMs: 1 }, { client: 'b', reply: 'y', labels: [], latencyMs: 1 },
    { client: 'c', reply: 'z', labels: ['DEMO_END', 'REQUEST'], request: { type: 'consultation', fields: { city: 'Ашдод', when: 'в среду' } }, latencyMs: 1 }];
  assert.deepEqual(codeChecks({ id: 'x', turns: [], checks: [], labels_expect: { turn1: ['DEMO_START'], turn3: ['DEMO_END'] } }, turns).map(c => c.pass), [true, true]);
  assert.deepEqual(codeChecks({ id: 'x', turns: [], checks: [], labels_expect: ['REQUEST'], request_fields: { type: 'consultation', city: 'Ашдод', when: 'среда' } }, turns).map(c => c.pass), [true, true, true, true]);
  assert.deepEqual(codeChecks({ id: 'x', turns: [], checks: [], labels_forbid: ['DEMO_START'] }, turns).map(c => c.pass), [false]);
});

test('a failed model call fails only its scenario, with the operational reason in the code checks and report', () => {
  const turns = [{ client: 'a', reply: null, labels: [], latencyMs: 1, error: 'incomplete_max_tokens' }];
  const code = codeChecks({ id: 'x', turns: [], checks: [], labels_forbid: ['REQUEST'] }, turns);
  assert.deepEqual(code, [{ check: 'model call (incomplete_max_tokens)', pass: false }, { check: 'no REQUEST', pass: true }]);
  const report = formatInstructionReport('t', [{ model: 'm', runs: [{ id: 'x', run: 1, turns, code, judge: [] }], stats: { calls: 0, latencyMs: 0, input: 0, output: 0, thinking: 0 }, cost: 0 }]);
  assert.match(report, /\| x \| 0\/1 \| 50\.0 % \| — \| model call \(incomplete_max_tokens\) \|/);
  assert.match(report, /ошибка модели: incomplete_max_tokens/);
});
