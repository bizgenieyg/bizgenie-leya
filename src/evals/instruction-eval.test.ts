import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { codeChecks, emptyStats, formatInstructionReport, loadInstructionScenarios, tenantScenarios } from './instruction-eval.js';

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
  const report = formatInstructionReport('t', [{ model: 'm', runs: [{ id: 'x', run: 1, turns, code, judge: [] }], stats: emptyStats() }]);
  assert.match(report, /\| x \| 0\/1 \| 50\.0 % \| — \| model call \(incomplete_max_tokens\) \|/);
  assert.match(report, /ошибка модели: incomplete_max_tokens/);
});

test('eval cost rules: judge calibration agreement is counted item by item', async () => {
  const { judgeAgreement } = await import('./instruction-eval.js');
  const run = (id: string, main: boolean[], cand?: boolean[]) => ({ id, run: 1, turns: [], code: [], judge: main.map((pass, i) => ({ check: `c${i}`, pass })), ...(cand ? { calibration: cand.map((pass, i) => ({ check: `c${i}`, pass })) } : {}) });
  assert.equal(judgeAgreement([run('a', [true])]), null);
  const a = judgeAgreement([run('a', [true, false, true], [true, true, true]), run('b', [false], [false])])!;
  assert.deepEqual([a.agree, a.total], [3, 4]);
  assert.deepEqual(a.disagreements, [{ id: 'a', run: 1, check: 'c1', main: false, candidate: true }]);
});

test('eval cost rules: a missing saved facts fixture is an error, not a paid extraction; 402 stops extraction and the judge', async () => {
  const { loadEvalFacts, judge, PaymentStop } = await import('./instruction-eval.js');
  const { AIProviderError } = await import('../providers/ai/ai-provider.interface.js');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(`${tmpdir()}/eval-facts-`);
  writeFileSync(`${dir}/src.md`, 'исходник');
  let calls = 0;
  const extract = async () => { calls++; throw new AIProviderError('x', undefined, { reason: 'http_402' }); };
  const base = { dir, ai: { generateReply: async () => ({ text: '' }) }, extract, modelLabel: 'm' };
  await assert.rejects(loadEvalFacts('ira', { kind: 'extract', file: 'src.md', saved: 'saved.md' }, { ...base, extractNow: false }), /saved\.md is missing — restore it from Git or rebuild it with --extract-facts=ira/);
  assert.equal(calls, 0, 'no paid call without --extract-facts');
  await assert.rejects(loadEvalFacts('ira', { kind: 'extract', file: 'src.md', saved: 'saved.md' }, { ...base, extractNow: true }), (e: Error) => e instanceof PaymentStop);
  assert.equal(calls, 1, 'no smaller-chunk retries after 402');
  writeFileSync(`${dir}/saved.md`, '## about\n- Факт один\n');
  assert.deepEqual(await loadEvalFacts('ira', { kind: 'extract', file: 'src.md', saved: 'saved.md' }, { ...base, extractNow: false }), [{ topic: 'about', text: 'Факт один' }]);
  const paymentJudge = { async generateReply(): Promise<never> { throw new AIProviderError('x', undefined, { reason: 'http_402' }); } };
  await assert.rejects(judge(paymentJudge, { id: 's', turns: [], checks: ['a'] }, []), (e: Error) => e instanceof PaymentStop);
  const brokenJudge = { async generateReply(): Promise<never> { throw new AIProviderError('x', undefined, { reason: 'timeout' }); } };
  assert.deepEqual(await judge(brokenJudge, { id: 's', turns: [], checks: ['a'] }, []), [{ check: 'a [judge_timeout]', pass: false }], 'other judge failures stay marked items');
});

test('402 in the fact rewrite step (real extractFacts) stops eval with PaymentStop, no smaller-chunk retries', async () => {
  const { loadEvalFacts, PaymentStop } = await import('./instruction-eval.js');
  const { extractFacts } = await import('../services/fact-extraction.service.js');
  const { AIProviderError } = await import('../providers/ai/ai-provider.interface.js');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(`${tmpdir()}/eval-facts-`);
  writeFileSync(`${dir}/src.md`, 'Есть ли пробный период? Да, две недели.');
  let calls = 0;
  const ai = { async generateReply(input: { systemPrompt: string }) {
    calls++;
    if (input.systemPrompt.startsWith('Эти факты добавляют')) throw new AIProviderError('x', undefined, { reason: 'http_402' });
    return { text: JSON.stringify({ facts: [{ topic: 'booking', text: 'Бесплатный пробный период на две недели.', quote: 'Есть ли пробный период? Да, две недели.', added_claims: [] }] }) };
  } };
  await assert.rejects(loadEvalFacts('ira', { kind: 'extract', file: 'src.md', saved: 'saved.md' },
    { dir, ai: ai as never, extractNow: true, extract: (m, s, chunk) => extractFacts(m, s, [], chunk), modelLabel: 'm' }), (e: Error) => e instanceof PaymentStop && /facts extraction \(ira\)/.test(e.message));
  assert.equal(calls, 2, 'extraction + rewrite, nothing after the 402');
});
