import assert from 'node:assert/strict';
import test from 'node:test';
import { blockCovered, extractFacts, isServiceBlock, quoteInSource, requiredGaps, sourceBlocks, splitForExtraction } from './fact-extraction.service.js';
import { requiredTopics } from '../config/knowledge-topics.js';

/** Synthetic Q&A base in the BizGenie layout (sections, question lines, answers); not the production text. */
const BASE = `# База знаний
Готово к загрузке. Формат файла: markdown.

## Сроки
**Сколько занимает внедрение?**
От 3-4 дней, зависит от объёма.

**Есть ли пробный период?**
Да, две недели бесплатно.

## Оплата и отказ
Как платить?
Сейчас идёт пробный период. Способы оплаты настроим после него.
Как отказаться?
Отключаете ассистента и прекращаете оплату.

## Безопасность и данные
Могут ли заблокировать номер?
Мы работаем через неофициальный API, риск блокировки есть при массовых рассылках.`;

test('parts are cut at sections and blank lines, never inside a pair', () => {
  const parts = splitForExtraction(BASE, 200);
  assert.ok(parts.length >= 3);
  for (const part of parts) assert.ok(!/^Да, две недели/m.test(part) || /Есть ли пробный период\?/.test(part), 'answer stays with its question');
  assert.deepEqual(splitForExtraction('a\n\nb', 2500), ['a\n\nb']);
  const long = 'x'.repeat(5000);
  assert.ok(splitForExtraction(long, 2500).every(p => p.length <= 2500));
});

test('blocks: one per question with its answer, headings dropped, service text recognised', () => {
  const blocks = sourceBlocks(BASE);
  assert.ok(blocks.includes('**Сколько занимает внедрение?**\nОт 3-4 дней, зависит от объёма.'));
  assert.ok(blocks.includes('Как отказаться?\nОтключаете ассистента и прекращаете оплату.'));
  assert.ok(!blocks.some(b => b.startsWith('#')));
  assert.deepEqual(blocks.filter(isServiceBlock), ['Готово к загрузке. Формат файла: markdown.']);
});

test('quotes survive dash, quote-mark, whitespace and emphasis differences; coverage uses them', () => {
  assert.equal(quoteInSource('От 3–4 дней', BASE), true, 'en dash vs hyphen');
  assert.equal(quoteInSource('Сколько занимает внедрение?', BASE), true, 'markdown emphasis');
  assert.equal(quoteInSource('«неофициальный API»', 'Мы работаем через "неофициальный API", риск'), true);
  assert.equal(quoteInSource('От 5 дней', BASE), false);
  assert.equal(blockCovered('Как отказаться?\nОтключаете ассистента и прекращаете оплату.', ['прекращаете оплату']), true);
  assert.equal(blockCovered('Как платить?\nСпособы оплаты настроим после него.', ['прекращаете оплату']), false);
});

test('uncovered blocks go back to the model once; only service/duplicate skips count, others stay uncovered', async () => {
  const calls: string[] = [];
  const ai = { async generateReply(input: { systemPrompt: string; userMessage: string }) {
    calls.push(input.systemPrompt.slice(0, 20));
    if (input.systemPrompt.startsWith('Эти фрагменты')) {
      const { fragments } = JSON.parse(input.userMessage) as { fragments: Array<{ index: number; text: string }> };
      const pay = fragments.find(f => f.text.includes('Способы оплаты')), risk = fragments.find(f => f.text.includes('заблокировать')), trial = fragments.find(f => f.text.includes('пробный период?'));
      return { text: JSON.stringify({ facts: [{ topic: 'payment_cancel', text: 'Оплату настроят после пробного периода.', quote: 'Способы оплаты настроим после него' }],
        skip: [{ index: risk?.index, reason: 'not relevant' }, { index: trial?.index, reason: 'duplicate', duplicate_of: 'Внедрение от 3–4 дней.' }, { index: pay?.index, reason: 'service' }] }), usage: { input_tokens: 50, output_tokens: 20, finish_reason: 'STOP' } };
    }
    // First pass keeps only half: the "compression" seen on 29.09.
    return { text: JSON.stringify({ facts: [
      { topic: 'booking', text: 'Внедрение занимает от 3–4 дней.', quote: 'От 3–4 дней' },
      { topic: 'payment_cancel', text: 'Отказаться просто: отключаете ассистента и прекращаете оплату.', quote: 'Отключаете ассистента и прекращаете оплату' },
      { topic: 'faq', text: 'Выдуманный факт.', quote: 'этого нет в тексте' }], gaps: [] }), usage: { input_tokens: 100, output_tokens: 40, thinking_tokens: 10, finish_reason: 'STOP' } };
  } };
  const r = await extractFacts(ai as never, BASE, [], 5000);
  assert.deepEqual(r.facts.map(f => f.topic), ['booking', 'payment_cancel', 'payment_cancel']);
  assert.equal(r.dropped, 1); assert.match(r.droppedFacts![0]!.quote, /этого нет/);
  assert.equal(r.coverage!.blocks, 5);
  assert.equal(r.coverage!.covered, 3);
  assert.deepEqual(r.coverage!.skipped.map(s => s.reason), ['duplicate'], '"service" for a covered block and an invented reason do not count');
  assert.equal(r.coverage!.uncovered.length, 1); assert.match(r.coverage!.uncovered[0]!, /заблокировать/);
  assert.deepEqual(r.calls!.map(c => [c.retry, c.finishReason]), [[false, 'STOP'], [true, 'STOP']]);
});

test('gaps: every required topic of the sector without facts, whatever the model says', () => {
  const required = requiredTopics('автоматизация');
  assert.deepEqual(required, ['services_prices', 'location_hours', 'booking', 'faq', 'payment_cancel', 'why_us']);
  assert.deepEqual(requiredGaps(required, ['services_prices', 'faq', 'booking', 'location_hours', 'why_us'], []), ['payment_cancel']);
  assert.deepEqual(requiredGaps(required, required, ['about']), ['about']);
  assert.deepEqual(requiredGaps(requiredTopics('маникюр'), ['services_prices'], []), ['location_hours', 'booking', 'faq', 'payment_cancel', 'why_us']);
});
