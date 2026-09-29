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
  // The invented quote, and the stand-in's second-round fact whose quote is not in the fragments sent back.
  assert.equal(r.dropped, 2); assert.match(r.droppedFacts![0]!.quote, /этого нет/);
  assert.equal(r.coverage!.blocks, 5);
  assert.equal(r.coverage!.covered, 3);
  // "service" for a covered block and an invented reason do not count; the "duplicate" of a fact without
  // "две недели" is refused, asked again with the missing details and stays uncovered when refused again.
  assert.deepEqual(r.coverage!.skipped, []);
  assert.equal(r.coverage!.uncovered.length, 2); assert.match(r.coverage!.uncovered.join('\n'), /заблокировать/); assert.match(r.coverage!.uncovered.join('\n'), /две недели/);
  assert.equal(r.rejectedSkips!.length, 2);
  assert.deepEqual(r.calls!.map(c => [c.retry, c.finishReason]), [[false, 'STOP'], [true, 'STOP'], [true, 'STOP']]);
});

test('gaps: every required topic of the sector without facts, whatever the model says', () => {
  const required = requiredTopics('автоматизация');
  assert.deepEqual(required, ['services_prices', 'location_hours', 'booking', 'faq', 'payment_cancel', 'why_us']);
  assert.deepEqual(requiredGaps(required, ['services_prices', 'faq', 'booking', 'location_hours', 'why_us'], []), ['payment_cancel']);
  assert.deepEqual(requiredGaps(required, required, ['about']), ['about']);
  assert.deepEqual(requiredGaps(requiredTopics('маникюр'), ['services_prices'], []), ['location_hours', 'booking', 'faq', 'payment_cancel', 'why_us']);
});

// Task W follow-up: the two additions and the questionable duplicate skip seen in the 29.09 dry run.
import { claimsBeyondQuote, detailsMissing, duplicateAccepted, quoteAsFact } from './fact-extraction.service.js';

test('claims beyond the quote: "бесплатный" and "и давно" are caught; words present in the quote are not', () => {
  assert.deepEqual(claimsBeyondQuote('Предоставляется бесплатный пробный период на две недели.', 'Есть ли пробный период? Да, две недели.'), ['бесплатн']);
  assert.deepEqual(claimsBeyondQuote('Разработка ботов для Telegram — отдельное направление, боты создаются так же часто и давно, как и для WhatsApp.', 'Да, боты для Telegram - отдельное направление, делаю их столько же, сколько для WhatsApp.'), ['давно']);
  assert.deepEqual(claimsBeyondQuote('Отказаться можно в любой момент, отключив ассистента.', 'Отключаете ассистента и прекращаете оплату.'), ['любой момент', 'в любой']);
  assert.deepEqual(claimsBeyondQuote('Аудит стоит 400 шекелей и возвращается при подключении.', 'Аудит - 400 шекелей, при подключении ассистента или CRM возвращается.'), []);
  assert.deepEqual(claimsBeyondQuote('Установка от 600 шекелей.', 'Установка - от 500 шекелей'), ['600']);
  assert.equal(quoteAsFact('**Есть ли пробный период?** Да, две недели.'), 'Да, две недели.');
});

test('flagged facts get one rewrite by the quote; a rewrite that still adds falls back to the quote', async () => {
  const ai = { async generateReply(input: { systemPrompt: string; userMessage: string }) {
    if (input.systemPrompt.startsWith('Эти факты добавляют')) {
      const { facts } = JSON.parse(input.userMessage) as { facts: Array<{ index: number; text: string }> };
      return { text: JSON.stringify({ facts: facts.map(f => ({ index: f.index, text: f.text.includes('пробный') ? 'Есть пробный период — две недели.' : 'Боты для Telegram делаются давно и часто.' })) }) };
    }
    if (input.systemPrompt.startsWith('Эти фрагменты')) return { text: '{"facts":[],"skip":[]}' };
    return { text: JSON.stringify({ facts: [
      { topic: 'booking', text: 'Предоставляется бесплатный пробный период на две недели.', quote: 'Есть ли пробный период? Да, две недели.', added_claims: [] },
      { topic: 'services_prices', text: 'Боты для Telegram создаются так же часто и давно, как для WhatsApp.', quote: 'Да, боты для Telegram - отдельное направление, делаю их столько же, сколько для WhatsApp.', added_claims: ['давно'] }] }) };
  } };
  const source = 'Есть ли пробный период? Да, две недели.\n\nДа, боты для Telegram - отдельное направление, делаю их столько же, сколько для WhatsApp.';
  const r = await extractFacts(ai as never, source, [], 2500);
  assert.deepEqual(r.facts.map(f => f.text), ['Есть пробный период — две недели.', 'Да, боты для Telegram - отдельное направление, делаю их столько же, сколько для WhatsApp.']);
  assert.deepEqual(r.rewritten!.map(x => x.fallback), [false, true]);
  assert.ok(r.facts.every(f => claimsBeyondQuote(f.text, f.quote).length === 0));
});

test('"duplicate" skip needs every detail in the named fact: the examples block brings back "рассылки для салона"', async () => {
  const block = '**Какие примеры ваших работ?**\nСистема управления гостями для бизнес-клуба, ассистент приёма заказов для домашней кухни, рассылки для салона - всё работает в продакшене.';
  const experience = 'BizGenie имеет опыт работы с салонами красоты, домашней кухней, ритейлом, риелторами и бизнес-клубами.';
  assert.equal(duplicateAccepted(block, experience), false);
  assert.ok(detailsMissing(block, experience).includes('рассылки'));
  assert.equal(duplicateAccepted('**Сколько стоит аудит?**\nСтоит 400 шекелей и возвращается при подключении.', 'Аудит стоит 400 шекелей и возвращается при подключении ассистента или CRM.'), true);
  const rounds: string[] = [];
  const ai = { async generateReply(input: { systemPrompt: string; userMessage: string }) {
    if (input.systemPrompt.startsWith('Эти фрагменты')) {
      const { fragments } = JSON.parse(input.userMessage) as { fragments: Array<{ index: number; missing_details?: string[] }> };
      rounds.push(fragments[0]!.missing_details ? 'hint' : 'first');
      if (!fragments[0]!.missing_details) return { text: JSON.stringify({ facts: [], skip: [{ index: 0, reason: 'duplicate', duplicate_of: experience }] }) };
      return { text: JSON.stringify({ facts: [{ topic: 'why_us', text: 'Примеры работ: система управления гостями для бизнес-клуба, ассистент приёма заказов для домашней кухни, рассылки для салона.', quote: 'Система управления гостями для бизнес-клуба, ассистент приёма заказов для домашней кухни, рассылки для салона', added_claims: [] }], skip: [] }) };
    }
    return { text: JSON.stringify({ facts: [{ topic: 'why_us', text: experience, quote: 'Работал с салонами красоты', added_claims: [] }] }) };
  } };
  const r = await extractFacts(ai as never, `Работал с салонами красоты, домашней кухней.\n\n${block}`, [], 2500);
  assert.deepEqual(rounds, ['first', 'hint']);
  assert.ok(r.facts.some(f => /рассылки для салона/.test(f.text)));
  assert.equal(r.coverage!.skipped.length, 0);
  assert.equal(r.rejectedSkips!.length, 1);
});
