import assert from 'node:assert/strict';
import test from 'node:test';
import { polishOwnerAnswer, polishedAnswerIsSafe } from './ai-fallback.service.js';

const context = { knowledge: [{ id: '1', question: 'Цена?', answer: 'Стрижка 90 шекелей' }], business: null };

test('polish guard rejects numbers absent from owner answer, question and knowledge', () => {
  assert.equal(polishedAnswerIsSafe('Да, можно в 15:00.', 'да', ['Можно в 15:00?']), true);
  assert.equal(polishedAnswerIsSafe('Стрижка стоит 90 шекелей.', 'да', ['Стрижка 90 шекелей']), true);
  assert.equal(polishedAnswerIsSafe('Да, это 150 шекелей.', 'да', ['Можно?']), false);
});

test('polish guard keeps yes/no polarity', () => {
  assert.equal(polishedAnswerIsSafe('К сожалению, нельзя.', 'нет', []), true);
  assert.equal(polishedAnswerIsSafe('Да, приходите.', 'нет', []), false);
  assert.equal(polishedAnswerIsSafe('לא, אי אפשר.', 'לא', []), true);
  assert.equal(polishedAnswerIsSafe('No, not this time.', 'yes', []), false);
});

test('polishOwnerAnswer returns null without model, on empty output and on failure', async () => {
  assert.equal(await polishOwnerAnswer('Можно?', 'да', context, 'ru', null, true), null);
  assert.equal(await polishOwnerAnswer('Можно?', 'да', context, 'ru', { async generateReply() { return { text: '  ' }; } }, true), null);
  assert.equal(await polishOwnerAnswer('Можно?', 'да', context, 'ru', { async generateReply() { throw new Error('x'); } }, true), null);
  assert.equal(await polishOwnerAnswer('Можно?', 'да', context, 'ru', { async generateReply() { return { text: 'Да, {answer}' }; } }, true), null);
  const verifier = (verdict: string) => ({ async generateReply() { return { text: verdict }; } });
  const polisher = { async generateReply() { return { text: 'Да, можно.' }; } };
  assert.equal(await polishOwnerAnswer('Можно?', 'да', context, 'ru', polisher, true, verifier('{"adds_facts":false,"changes_meaning":false}')), 'Да, можно.');
  assert.equal(await polishOwnerAnswer('Можно?', 'да', context, 'ru', polisher, true, verifier('```json\n{"adds_facts": false, "changes_meaning": false}\n```')), 'Да, можно.');
  for (const verdict of ['{"adds_facts":true,"changes_meaning":false}', '{"adds_facts":false,"changes_meaning":true}', 'looks fine', '{"adds_facts":"no"}', '[]'])
    assert.equal(await polishOwnerAnswer('Можно?', 'да', context, 'ru', polisher, true, verifier(verdict)), null, verdict);
  assert.equal(await polishOwnerAnswer('Можно?', 'да', context, 'ru', polisher, true, { async generateReply() { throw new Error('down'); } }), null);
});

test('reviewer example: an invented condition without numbers passes the cheap guard but the verifier rejects it', async () => {
  assert.equal(polishedAnswerIsSafe('Да, можно, мастер приедет к вам домой.', 'да', ['Можно записаться?']), true);
  let verifierInput: Record<string, unknown> = {};
  const polisher = { async generateReply() { return { text: 'Да, можно, мастер приедет к вам домой.' }; } };
  const verifier = { async generateReply(input: { userMessage: string }) { verifierInput = JSON.parse(input.userMessage); return { text: '{"adds_facts":true,"changes_meaning":false}' }; } };
  assert.equal(await polishOwnerAnswer('Можно записаться?', 'да', context, 'ru', polisher, true, verifier), null);
  assert.equal(verifierInput.ownerAnswer, 'да');
  assert.equal(verifierInput.polishedAnswer, 'Да, можно, мастер приедет к вам домой.');
});
