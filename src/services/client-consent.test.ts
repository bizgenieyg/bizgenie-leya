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

test('preferredName: what the client called themselves, only length and no digits or links', async () => {
  const { preferredName } = await import('./client-consent.js');
  for (const [input, expected] of [['Аня', 'Аня'], ['аня', 'Аня'], ['Мама', 'Мама'], ['Анна Мария', 'Анна Мария'], ['Anna2', null], ['anya.com', null], ['@anya', null], ['a'.repeat(41), null], ['', null], [null, null]] as const)
    assert.equal(preferredName(input), expected, String(input));
});

test('task X: offer questions, "да хочу" as consent, neutral confirmation with time', async () => {
  const { isOfferQuestion } = await import('./message-pipeline.service.js');
  const { renderGreeting } = await import('./templates.service.js');
  assert.equal(isOfferQuestion('Ассистент отвечает круглосуточно. Хотите, Юрий покажет за 20 минут, как это будет работать у вас?'), true);
  assert.equal(isOfferQuestion('Могу передать ваш вопрос Юрию — передать?'), true);
  assert.equal(isOfferQuestion('Ассистент отвечает круглосуточно. Чем занимается ваш бизнес?'), false);
  assert.equal(isOfferQuestion('Встреча занимает 20 минут.'), false, 'not a question');
  for (const text of ['да хочу', 'хочу', 'Да, хочу!', 'давай', 'конечно']) assert.ok(agreement(text), text);
  assert.equal(agreement('не хочу'), null);
  assert.equal(renderGreeting(undefined, 'client.request_sent', 'ru', { owner_name: 'Юрий', time: 'четверг' }), 'Готово! Юрий свяжется с вами в четверг.');
  assert.equal(renderGreeting(undefined, 'client.request_sent', 'ru', { owner_name: 'Юрий', client_first_name: 'Аня' }), 'Готово, Аня! Юрий свяжется с вами.');
  assert.equal(renderGreeting(undefined, 'client.request_sent', 'en', { owner_name: 'Yuri', time: 'Thursday' }), 'Done! Yuri will get in touch with you on Thursday.');
  for (const lang of ['ru', 'he', 'en']) assert.doesNotMatch(renderGreeting(undefined, 'client.request_sent', lang, { owner_name: 'X' }), /Передала|העברתי|I've passed/);
  // Old defaults stored by tenants are read as "not edited".
  assert.equal(renderGreeting({ templates: { 'client.request_sent': { ru: 'Спасибо{, client_first_name}! Передала вашу заявку — {owner_name} свяжется с вами.' } } } as never, 'client.request_sent', 'ru', { owner_name: 'Юрий' }), 'Готово! Юрий свяжется с вами.');
});

test('task X: the prompt allows an offer only when code says so, and speaks of the owner in the third person', async () => {
  const { conversationRules } = await import('./ai-fallback.service.js');
  assert.match(conversationRules({ mayOffer: false }), /НЕ предлагай встречу/);
  assert.match(conversationRules({ mayOffer: true, ownerName: 'Юрий' }), /Юрий покажет за 20 минут/);
  assert.doesNotMatch(conversationRules({ mayOffer: true, ownerName: 'Юрий' }), /система сама спросит/);
  assert.match(conversationRules({ needClientName: true, pendingOffer: 'демо' }), /как к клиенту обращаться[^]*"consent": true/);
  assert.match(REPLY_PRINCIPLES, /в третьем лице по имени/);
  assert.doesNotMatch((await import('./ai-fallback.service.js')).ANSWER_RULES, /покажу за 20 минут/);
});

test('task X: assistant actions are not owner offers; "получит цену" is not "передано"', async () => {
  const { isOfferQuestion } = await import('./message-pipeline.service.js');
  const { CLAIMED_PASSED_PATTERN } = await import('../config/consent.js');
  assert.equal(isOfferQuestion('Ассистент отвечает сразу. Показать пример?'), false);
  assert.equal(isOfferQuestion('Есть пробный период. Посчитать, сколько времени это сэкономит вам?'), false);
  assert.equal(CLAIMED_PASSED_PATTERN.test('Клиент сразу получит цену и не уйдёт к конкуренту.'), false);
  assert.equal(CLAIMED_PASSED_PATTERN.test('Юрий получит вашу заявку и перезвонит.'), true);
  assert.equal(CLAIMED_PASSED_PATTERN.test('Отлично, Юрий свяжется с вами.'), true);
});
