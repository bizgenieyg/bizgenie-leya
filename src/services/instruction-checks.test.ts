import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { checkedNumbers, missingFields, normalizeNumber, parseLabels, parseRequestValue, unbackedNumbers, unsafeClientText } from './instruction-checks.js';
import { fillPlaceholders } from './instructions.service.js';
import { CORE_INSTRUCTION_DEFAULT, CORE_LANGUAGE_DEFAULTS, DEMO_INSTRUCTION_DEFAULTS } from '../config/instruction-defaults.js';

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
  assert.equal(CORE_LANGUAGE_DEFAULTS.he, readFileSync('evals/instructions/core-he.md', 'utf8'));
  assert.equal(CORE_LANGUAGE_DEFAULTS.ru, readFileSync('evals/instructions/core-ru.md', 'utf8'));
  assert.equal(DEMO_INSTRUCTION_DEFAULTS.home_cook, readFileSync('evals/instructions/demo-home-cook.md', 'utf8'));
  assert.equal(DEMO_INSTRUCTION_DEFAULTS.cosmetologist, readFileSync('evals/instructions/demo-cosmetologist.md', 'utf8'));
});

test('Z12: the text after [[REQUEST]] is the owner card, never client text; [[ASK_OWNER]] may repeat', async () => {
  const { labelValues } = await import('./instruction-checks.js');
  const r = parseLabels('Передала Юрию, он свяжется с вами.\n[[REQUEST: meeting | topic=звонок; time=среда 14:00]]\n👤 Клиент: Анна\n📞 Хочет: звонок\n🕐 Удобно (пожелание клиента): среда 14:00\n[[OFFER]]');
  assert.equal(r.text, 'Передала Юрию, он свяжется с вами.');
  assert.equal(r.card, '👤 Клиент: Анна\n📞 Хочет: звонок\n🕐 Удобно (пожелание клиента): среда 14:00');
  assert.deepEqual(r.labels.map(l => l.name), ['REQUEST', 'OFFER']);
  const two = parseLabels('Уточню у Юрия.\n[[ASK_OWNER: делаете ли видео?]]\n[[ASK_OWNER: есть ли скидка на год?]]');
  assert.deepEqual(labelValues(two, 'ASK_OWNER'), ['делаете ли видео?', 'есть ли скидка на год?']);
  assert.equal(two.card, undefined);
});

test('Z12: the instruction gives the common part and the section of the role; no headings — all of it', async () => {
  const { instructionForRole } = await import('./instruction-engine.service.js');
  const text = 'Общее 1\n### Продажа\nПродаём\n### Поддержка\nПомогаем\n### Общее\nОбщее 2';
  assert.equal(instructionForRole(text, 'SALES'), 'Общее 1\nПродаём\nОбщее 2');
  assert.equal(instructionForRole(text, 'SUPPORT'), 'Общее 1\nПомогаем\nОбщее 2');
  assert.equal(instructionForRole('Без разделов\n5. Продажа — шаг', 'SUPPORT'), 'Без разделов\n5. Продажа — шаг');
  for (const key of ['bizgenie', 'templates/service_booking', 'templates/order', 'templates/project', 'templates/b2b', 'templates/general']) {
    const file = readFileSync(`evals/instructions/${key}.md`, 'utf8');
    assert.notEqual(instructionForRole(file, 'SALES'), instructionForRole(file, 'SUPPORT'), `${key}: both sections`);
  }
});

test('Z12: support keywords and farewells (ru/he/en)', async () => {
  const { matchesSupportKeywords } = await import('./reply-role.service.js');
  const { clientIsLeaving } = await import('../config/roles.js');
  for (const text of ['Где мой заказ?', 'хочу перенести запись', 'ההזמנה שלי לא הגיעה', 'I want to cancel']) assert.equal(matchesSupportKeywords(text), true, text);
  for (const text of ['Сколько стоит?', 'כמה זה עולה?', 'How much is it?']) assert.equal(matchesSupportKeywords(text), false, text);
  for (const text of ['Нет, спасибо', 'передумал', 'לא צריך, תודה', 'never mind']) assert.equal(clientIsLeaving(text), true, text);
  assert.equal(clientIsLeaving('А в среду можно?'), false);
});

test('Z12: the moment block — date, name, open questions or «нет открытых», quiet hours, voice', async () => {
  const { momentBlock } = await import('./instruction-engine.service.js');
  const settings = { time_zone: 'Asia/Jerusalem', mode: 'normal', quiet_hours_start: null, quiet_hours_end: null } as never;
  const now = new Date('2026-10-28T10:00:00Z');
  const open = momentBlock({ settings, clientName: 'Yana Melman', openQuestions: ['Делаете ли видео?'], voice: true, now }, 'Юрий');
  assert.match(open, /Сегодня среда, 28 октября 2026/);
  assert.match(open, /ИЗВЕСТНОЕ ИМЯ КЛИЕНТА \(из WhatsApp\): Yana Melman/);
  assert.match(open, /ждёшь ответа на:\n- «Делаете ли видео\?»/);
  assert.match(open, /ГОЛОСОВЫМ/);
  const none = momentBlock({ settings, openQuestions: [], now }, 'Юрий');
  assert.match(none, /открытых вопросов нет — все ответы переданы/);
  assert.doesNotMatch(none, /ИЗВЕСТНОЕ ИМЯ|ГОЛОСОВЫМ/);
  const quiet = momentBlock({ settings: { ...(settings as object), mode: 'mute_all', quiet_hours_start: '00:00', quiet_hours_end: '23:00' } as never, now }, 'Юрий');
  assert.match(quiet, /Юрий не на связи и отвечает с/);
});

test('Z12: the daily review — every dialog once, unknown values safe; the report time and day', async () => {
  const { parseReview, reportDue } = await import('./daily-report.service.js');
  const r = parseReview('```json\n{"dialogs":[{"id":"a","summary":"хочет абонемент","outcome":"lost","reason":"price"},{"id":"x","outcome":"request"}],"findings":[{"id":"a","kind":"price_not_in_facts","reply_excerpt":"стоит 900 ₪"},{"id":"zz","kind":"other"}]}\n```', ['a', 'b']);
  assert.deepEqual(r.dialogs, [{ id: 'a', summary: 'хочет абонемент', outcome: 'lost', reason: 'price' }, { id: 'b', summary: '—', outcome: 'info_only', reason: null }]);
  assert.deepEqual(r.findings.map(f => f.id), ['a']);
  assert.equal(r.ok, false, 'a dialog without an outcome — the review is not the day result');
  assert.equal(parseReview('not json', ['a']).dialogs[0]!.outcome, 'info_only');
  assert.equal(parseReview('{"dialogs":[],"findings":[]}', ['a']).ok, false, 'an empty review is not a success');
  assert.equal(parseReview('{"dialogs":[{"id":"a","outcome":"maybe"}]}', ['a']).ok, false);
  assert.equal(parseReview('{"dialogs":[{"id":"a","outcome":"info_only"}]}', ['a']).ok, true);
  const settings = { time_zone: 'Asia/Jerusalem' } as never;
  assert.equal(reportDue(settings, new Date('2026-10-28T05:30:00Z')), null, '07:30 local — not yet');
  assert.deepEqual(reportDue(settings, new Date('2026-10-28T07:05:00Z')), { reportDate: '2026-10-27' });
  assert.deepEqual(reportDue(settings, new Date('2026-11-01T07:05:00Z')), { reportDate: '2026-10-31' });
});
