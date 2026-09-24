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
  assert.equal(await polishOwnerAnswer('Можно?', 'да', context, 'ru', { async generateReply() { return { text: 'Да, можно.' }; } }, true), 'Да, можно.');
});
