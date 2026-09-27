import assert from 'node:assert/strict';
import test from 'node:test';
import { agreement, hasCallToAction, isDecline, isDirectRequest, usableFirstName } from './client-consent.js';
import { isSemanticRepeat } from './semantic-repeat.service.js';
import { REPLY_PRINCIPLES, SHORT_REPLY_RULES, selfIntroduction } from './ai-fallback.service.js';
import { TEMPLATE_DEFAULTS } from '../config/templates.js';

test('usableFirstName: real names only, first word capitalised', () => {
  const cases: Array<[string | null, string | null, string?]> = [
    ['Анна', 'Анна'], ['Anna K', 'Anna'], ['Юрий Иванов', 'Юрий'], ['марина', 'Марина'], ['Dana', 'Dana'], ['דנה', 'דנה'],
    ["O'Neil", "O'Neil"], ['Анна-Мария', 'Анна-Мария'], ['Мама', null], ['мама', null], ['Работа 💼', null], ['ИРИНА САЛОН', null],
    ['אמא', null], ['Love', null], ['Boss', null], ['Салон Ирины', null], ['Anna 2', null], ['@anna', null], ['a.b', null],
    ['Анна Мария Петровна', null], ['A', null], ['😊', null], ['', null], [null, null], ['ИРА', 'ИРА'], ['BizGenie', null, 'BizGenie'],
    ['Leya Studio', null, 'Leya Studio'], ['Абвгдеёжзийклмнопрсту', null],
  ];
  for (const [input, expected, business] of cases) assert.equal(usableFirstName(input, business), expected, String(input));
});

test('direct requests, negations, agreement and decline dictionaries', () => {
  for (const text of ['хочу демо', 'Запишите меня на четверг', 'перезвоните мне', 'давайте созвонимся', 'хочу подключить', 'можно приехать завтра?',
    'תקבע לי פגישה', 'אני רוצה דמו', 'call me tomorrow', 'I want to book', 'sign me up', 'can we schedule a meeting?'])
    assert.equal(isDirectRequest(text), true, text);
  for (const text of ['не надо звонить', 'не звоните мне', 'по объявлениям', 'у меня аренда авто', 'а как это мне поможет?', 'не хочу демо, просто спросить',
    'לא צריך לקבוע', "don't call me", 'no meeting please', 'just looking'])
    assert.equal(isDirectRequest(text), false, text);
  for (const text of ['да', 'Да!', 'давайте', 'ок', '👍', 'конечно', 'כן', 'סבבה', 'yes', 'sure', "let's"]) assert.ok(agreement(text), text);
  assert.equal(agreement('да, Аня')!.rest, 'аня');
  assert.equal(agreement('да, меня зовут Аня')!.rest, 'аня');
  for (const text of ['нет', 'да нет', 'да не надо', 'не сейчас', 'по объявлениям', 'да, но у меня вопрос про цену и сроки подключения сейчас']) assert.equal(agreement(text), null, text);
  for (const text of ['нет', 'не сейчас', 'я подумаю', 'позже', 'לא תודה', 'no thanks', 'not now']) assert.equal(isDecline(text), true, text);
  for (const text of ['да', 'нет ли у вас скидки для новых клиентов на первый месяц подключения?']) assert.equal(isDecline(text), false, text);
  assert.equal(hasCallToAction('Могу показать демо за 20 минут.'), true);
  assert.equal(hasCallToAction('Подключение 1500 ₪.'), false);
});

test('semantic repeat: cosine against each of the last replies, threshold from settings; failures never block', async () => {
  const embedder = (map: Record<string, number[]>) => ({ model: 'm', dimensions: 2, async embed(texts: string[]) { return { vectors: texts.map(t => map[t] ?? [0, 1]) }; } });
  const e = embedder({ a: [1, 0], b: [0.95, 0.31], c: [0.6, 0.8] });
  assert.deepEqual((await isSemanticRepeat('a', ['c', 'b'], e, 0.9)).repeat, true);
  assert.equal((await isSemanticRepeat('a', ['c'], e, 0.9)).repeat, false);
  assert.equal((await isSemanticRepeat('a', ['c'], e, 0.5)).repeat, true);
  assert.equal((await isSemanticRepeat('a', [], e, 0.9)).similarity, null);
  assert.equal((await isSemanticRepeat('a', ['b'], null, 0.9)).repeat, false);
  const broken = { model: 'm', dimensions: 2, async embed(): Promise<never> { throw new Error('x'); } };
  assert.deepEqual(await isSemanticRepeat('a', ['b'], broken, 0.9), { repeat: false, similarity: null });
});

test('prompts and defaults never introduce the assistant as "assistant of <owner>"', () => {
  assert.equal(selfIntroduction({ business: { business_name: 'BizGenie' } as never }), 'цифровой ассистент "BizGenie"');
  assert.equal(selfIntroduction({ business: null }), 'цифровой ассистент');
  for (const lang of ['ru', 'he', 'en']) assert.doesNotMatch(TEMPLATE_DEFAULTS['client.greeting']![lang]!, /owner_name/);
  assert.match(SHORT_REPLY_RULES, /напишите «…»/);
  assert.match(REPLY_PRINCIPLES, /Пугающие факты/);
});
