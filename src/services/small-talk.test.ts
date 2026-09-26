import assert from 'node:assert/strict';
import test from 'node:test';
import { isAcknowledgement, isBareGreeting, withoutLeadingGreeting } from '../utils/small-talk.js';

test('bare greetings in ru/he/en are recognised; anything with content is not', () => {
  for (const text of ['привет', 'Привет!', 'Здравствуйте', 'добрый вечер!', 'Доброе утро 🙂', 'хай', 'שלום', 'היי', 'בוקר טוב', 'מה נשמע?', 'hi', 'Hello!', 'hey there', 'Good morning', 'привет всем', '👋 привет'])
    assert.equal(isBareGreeting(text), true, text);
  for (const text of ['привет, сколько стоит бот?', 'Здравствуйте, Юрий?', 'хочу узнать про вас', 'hi, what do you do', 'שלום, כמה זה עולה', 'спасибо', '', 'привет '.repeat(10)])
    assert.equal(isBareGreeting(text), false, text);
});

test('thanks / ok / emoji without a question are acknowledgements', () => {
  for (const text of ['спасибо', 'Спасибо большое!', 'ок', 'Окей', '👍', '🙏🙏', 'תודה', 'תודה רבה', 'thanks!', 'thank you', 'ok 👍'])
    assert.equal(isAcknowledgement(text), true, text);
  for (const text of ['спасибо, а сколько стоит?', 'ок?', 'привет', 'хорошо, давайте встречу в четверг'])
    assert.equal(isAcknowledgement(text), false, text);
});

test('a leading greeting is dropped so the question is handled normally', () => {
  assert.equal(withoutLeadingGreeting('Привет, сколько стоит бот?'), 'сколько стоит бот?');
  assert.equal(withoutLeadingGreeting('Добрый вечер! Хочу узнать про вас'), 'Хочу узнать про вас');
  assert.equal(withoutLeadingGreeting('שלום, כמה זה עולה?'), 'כמה זה עולה?');
  assert.equal(withoutLeadingGreeting('сколько стоит?'), 'сколько стоит?');
  assert.equal(withoutLeadingGreeting('привет'), 'привет');
});
