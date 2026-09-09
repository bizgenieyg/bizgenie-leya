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
