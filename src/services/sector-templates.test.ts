import assert from 'node:assert/strict';
import test from 'node:test';
import { SECTOR_SUGGESTIONS, templateForSector } from '../config/instruction-templates.js';

test('Z8: every sector suggestion in ru/he/en gives its template — as picked, and by keywords alone', () => {
  // Z11: + equipment rental, car rental (order); «аренда (оборудования, жилья)» → «аренда жилья» (general).
  assert.equal(SECTOR_SUGGESTIONS.reduce((n, g) => n + g.items.length, 0), 45);
  for (const group of SECTOR_SUGGESTIONS) for (const item of group.items) for (const [language, text] of Object.entries(item)) {
    assert.equal(templateForSector(text), group.template, `${language}: ${text}`);
    assert.equal(templateForSector(` ${text.toUpperCase()} `), group.template, `${language}: ${text} (case, spaces)`);
    // A suffix defeats the exact match: the keyword table alone must give the same template.
    assert.equal(templateForSector(`${text} 1`), group.template, `${language}: ${text} (keywords)`);
  }
  assert.equal(templateForSector('сантехник'), 'project');
  assert.equal(templateForSector('мебель на заказ под ключ'), 'project');
  assert.equal(templateForSector('торты на заказ'), 'order');
  // Z11: rentals of things are orders (what is taken + dates); housing stays general.
  for (const text of ['аренда оборудования для свадеб', 'аренда автомобилей в Хайфе', 'השכרת ציוד צילום', 'השכרת רכב', 'equipment rental', 'car rental Tel Aviv']) assert.equal(templateForSector(text), 'order', text);
  for (const text of ['аренда жилья', 'аренда квартир посуточно', 'השכרת דירות', 'housing rental']) assert.equal(templateForSector(text), 'general', text);
  assert.ok(!SECTOR_SUGGESTIONS.find(g => g.group === 'other')!.items.some(i => /оборудования/.test(i.ru)), '«аренда» left «Прочее» except housing');
});
