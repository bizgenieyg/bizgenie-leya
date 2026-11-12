import assert from 'node:assert/strict';
import test from 'node:test';
import { withoutRepeatedIntroduction } from '../utils/assistant-text.js';

test('withoutRepeatedIntroduction drops a leading self-introduction only for a returning contact', () => {
  const ru = 'Я ассистент владельца. Открыто с 9 до 18.';
  const en = "I'm the owner's assistant. We open at 9.";
  const he = 'אני העוזרת של בעל העסק. פתוח מ-9.';

  // First reply in a conversation: keep the introduction verbatim.
  assert.equal(withoutRepeatedIntroduction(ru, false), ru);

  // Later replies: strip the introduction, keep the substance, in every language.
  assert.equal(withoutRepeatedIntroduction(ru, true), 'Открыто с 9 до 18.');
  assert.equal(withoutRepeatedIntroduction(en, true), "We open at 9.");
  assert.equal(withoutRepeatedIntroduction(he, true), 'פתוח מ-9.');

  // No introduction present: text is returned as-is.
  assert.equal(withoutRepeatedIntroduction('Просто ответ', true), 'Просто ответ');
  assert.equal(withoutRepeatedIntroduction('Цена 100 шек, доставка завтра.', true), 'Цена 100 шек, доставка завтра.');
});

test('Z17: a later reply loses the repeated greeting and self-introduction; the first keeps them; nothing else changes', () => {
  const cases: Array<[string, string]> = [
    ['Здравствуйте! Я Лея, ИИ-ассистент Ноготки. Нет, я помогаю Ольге с записью.', 'Нет, я помогаю Ольге с записью.'],
    ['Здравствуйте 🌷 Я Лея, ИИ-ассистент Ирены Прасолов.\nОтёк на второй день — это нормально.', 'Отёк на второй день — это нормально.'],
    ['Здравствуйте 🌷 Отёк на второй день — это нормально.', 'Отёк на второй день — это нормально.'],
    ['Привет, Диана! Чем могу помочь?', 'Чем могу помочь?'],
    ['שלום! אני ליה, העוזרת של BizGenie. המחיר 200 ₪.', 'המחיר 200 ₪.'],
    ["Hi! I'm Leya, BizGenie's AI assistant. We open at 9.", 'We open at 9.'],
    ['Я Лея, ИИ-ассистент BizGenie. Передала Юрию.', 'Передала Юрию.'],
    ['Здравствуйте! Я Лея, ИИ-ассистент BizGenie.', 'Здравствуйте! Я Лея, ИИ-ассистент BizGenie.'],
    ['Я передала ваш вопрос Юрию.', 'Я передала ваш вопрос Юрию.'],
    ['Привезём завтра.', 'Привезём завтра.'],
    ['Hiking tours start at 9.', 'Hiking tours start at 9.'],
    ['Здравствуйте, у нас открыто до 18.', 'У нас открыто до 18.'],
    ['Приветствуем новых клиентов скидкой.', 'Приветствуем новых клиентов скидкой.'],
    // Z17 review: a capitalised word not closed by punctuation is the reply, not a name.
    ['Hello, No appointments are available tomorrow.', 'No appointments are available tomorrow.'],
    ['Здравствуйте, Завтра мы закрыты.', 'Завтра мы закрыты.'],
    ['Hello, Anna! We open at 9.', 'We open at 9.'],
  ];
  for (const [input, expected] of cases) assert.equal(withoutRepeatedIntroduction(input, true), expected, input);
  assert.equal(withoutRepeatedIntroduction(cases[0]![0], false), cases[0]![0]);
});
