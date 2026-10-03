import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { checkedNumbers, missingFields, normalizeNumber, parseLabels, parseRequestValue, unbackedNumbers, unsafeClientText } from './instruction-checks.js';
import { fillPlaceholders } from './instructions.service.js';
import { CORE_INSTRUCTION_DEFAULT, DEMO_INSTRUCTION_DEFAULTS } from '../config/instruction-defaults.js';

test('labels are parsed, stripped from the client text; unknown ones reported, never executed', () => {
  const r = parseLabels('Юрий свяжется с вами в четверг.\n[[REQUEST: meeting | topic=демо; time=четверг]]\n[[OFFER]]\n[[BOOK: x]]');
  assert.equal(r.text, 'Юрий свяжется с вами в четверг.');
  assert.deepEqual(r.labels, [{ name: 'REQUEST', value: 'meeting | topic=демо; time=четверг' }, { name: 'OFFER', value: null }]);
  assert.deepEqual(r.unknown, ['BOOK']);
  assert.deepEqual(parseRequestValue('consultation | city=Ашдод; when=среда'), { type: 'consultation', fields: { city: 'Ашдод', when: 'среда' } });
  assert.deepEqual(missingFields({ type: 'procedure', fields: { service: 'губы', city: 'Ришон' } }, { procedure: ['service', 'city', 'when', 'allergy'] }), ['when', 'allergy']);
  assert.deepEqual(parseRequestValue('consultation | city=…; when=среда')!.fields, { when: 'среда' }, 'an ellipsis is not a value');
  for (const bad of ['', 'Цена {price}', 'ok ]]', 'undefined', 'значение null', '<b>x</b>']) assert.equal(unsafeClientText(bad), true, bad);
  assert.equal(unsafeClientText('Здравствуйте 🌷 Что вас интересует?'), false);
});

test('numbers next to units and HH:MM must be in the corpus; thousands and ranges normalised', () => {
  assert.equal(normalizeNumber('1 000'), '1000'); assert.equal(normalizeNumber('1.000'), '1000'); assert.equal(normalizeNumber('1,5'), '1.5');
  assert.deepEqual(checkedNumbers('Ботокс — 500 ₪ за зону, консультация 30 минут, приём с 10:00. Всего 3 зоны.'), ['500', '30', '10:00']);
  assert.deepEqual(checkedNumbers('от 700–1500 ₪ и ₪ 2 800'), ['700', '1500', '2800']);
  const corpus = 'Botox Full Face — 2800 ₪. Одна зона 500 ₪, две 1000 ₪. Консультация 30 мин. Приём 10:00–18:00.';
  assert.deepEqual(unbackedNumbers('Full Face стоит 2 800 ₪, одна зона 500 шекелей, приём с 10:00.', corpus), []);
  assert.deepEqual(unbackedNumbers('Микронидлинг — 900 ₪, 45 минут.', corpus), ['900', '45']);
  assert.deepEqual(unbackedNumbers('У нас 3 кабинета.', corpus), [], 'a number without a unit is not checked');
});

test('placeholders: filled, or the text is unusable with the missing names', () => {
  assert.deepEqual(fillPlaceholders('Ты — Лея, ассистент «{business_name}». Владелец — {owner_name}.', { business_name: 'BizGenie', owner_name: 'Юрий' }), { text: 'Ты — Лея, ассистент «BizGenie». Владелец — Юрий.', missing: [] });
  assert.deepEqual(fillPlaceholders('Владелец — {owner_name}.', { owner_name: '  ' }), { text: null, missing: ['owner_name'] });
  assert.equal(fillPlaceholders('JSON {x}', {}).text, 'JSON {x}', 'unknown braces are not placeholders');
});

test('config defaults are the instruction files verbatim', () => {
  assert.equal(CORE_INSTRUCTION_DEFAULT, readFileSync('evals/instructions/core.md', 'utf8'));
  assert.equal(DEMO_INSTRUCTION_DEFAULTS.home_cook, readFileSync('evals/instructions/demo-home-cook.md', 'utf8'));
  assert.equal(DEMO_INSTRUCTION_DEFAULTS.cosmetologist, readFileSync('evals/instructions/demo-cosmetologist.md', 'utf8'));
});

test('Z2: wrong language — the client script must dominate; Latin brand names do not count against ru/he', async () => {
  const { wrongLanguage } = await import('./instruction-engine.service.js');
  assert.equal(wrongLanguage('אссистент в WhatsApp возьмет на себя ответы на вопросы клиентов.', 'he'), true, 'one Hebrew letter is not a Hebrew reply');
  assert.equal(wrongLanguage('האסיסטנט ב-WhatsApp יענה ללקוחות.', 'he'), false);
  assert.equal(wrongLanguage('Ассистент в WhatsApp ответит клиентам: https://leya.bizgenie.site/login', 'ru'), false);
  assert.equal(wrongLanguage('הסייען יענה', 'ru'), true);
  assert.equal(wrongLanguage('The assistant answers in WhatsApp.', 'en'), false);
  assert.equal(wrongLanguage('Ассистент ответит.', 'en'), true);
  assert.equal(wrongLanguage('500 ₪', 'he'), true);
});
