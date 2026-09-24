import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { splitKnowledgeUnits } from './knowledge-units.js';
import { KNOWLEDGE_SYSTEM_PROMPT, SHORT_REPLY_RULES, generateReceptionReply } from './ai-fallback.service.js';
import { TEMPLATE_DEFAULTS } from '../config/templates.js';

const KB = readFileSync('src/services/fixtures/knowledge-base-structured.md', 'utf8');

test('structured base splits into whole question-answer pairs and sections', () => {
  const units = splitKnowledgeUnits(KB, 3000);
  assert.ok(units.some(u => u.includes('\n**Сколько стоит лендинг?**\n') && u.includes('от 3000 ₪')));
  assert.equal(units.length, 5);
  assert.ok(units.every(u => u.startsWith('## ')), 'every unit carries its section heading');
  assert.ok(units.some(u => u.includes('\nQ: Где вы находитесь?\nA:') && u.includes('Ришон')));
  assert.ok(units.some(u => u.includes('\nВ: Как с вами связаться?\n') && u.includes('О: Через WhatsApp')));
  for (const unit of units) {
    assert.match(unit, /^[#*A-ZА-ЯЁQВ\p{Lu}]/u, `unit starts mid-word: ${unit.slice(0, 20)}`);
    const questions = unit.split('\n').filter(line => /\?\**$/.test(line.trim()) || /^(Q|В):/.test(line.trim()));
    assert.ok(questions.length <= 1, 'a unit never carries two question-answer pairs');
  }
});

test('oversized units split by paragraph, repeat the heading and never break a sentence', () => {
  const body = Array.from({ length: 40 }, (_, i) => `Абзац ${i}. Предложение о правилах записи номер ${i}, достаточно длинное для проверки.`).join('\n\n');
  const units = splitKnowledgeUnits(`## Правила\n${body}`, 600);
  assert.ok(units.length > 3);
  for (const unit of units) {
    assert.ok(unit.startsWith('## Правила\n'));
    assert.ok(unit.length <= 600);
    assert.match(unit.trim(), /[.!?…]$/);
  }
  const flat = splitKnowledgeUnits('Одно длинное предложение без структуры. '.repeat(100), 500);
  assert.ok(flat.every(u => u.length <= 500 && /\.$/.test(u)));
});

test('short greetings: prompts cap replies at 1–2 sentences and forbid filler phrases in he/ru/en', () => {
  for (const phrase of ['с радостью помогу', 'постараюсь помочь', 'чем могу быть полезен', 'расскажите, пожалуйста, что вам нужно', "I'll be happy to help", 'אשמח לעזור'])
    assert.ok(SHORT_REPLY_RULES.includes(phrase), phrase);
  assert.match(SHORT_REPLY_RULES, /1–2 предложениями/);
  assert.ok(KNOWLEDGE_SYSTEM_PROMPT.includes(SHORT_REPLY_RULES));
  for (const languages of Object.values(TEMPLATE_DEFAULTS))
    for (const text of Object.values(languages))
      assert.doesNotMatch(text, /с радостью помогу|постараюсь помочь|чем могу быть полезен|что вам нужно|do my best to help|אעשה כמיטב/i);
});

test('reception prompt carries the short-reply rules and a one-phrase introduction', async () => {
  let prompt = '';
  await generateReceptionReply({ assistant: null, knowledge: [] }, 'Привет', 'Что именно вас интересует?', { async generateReply(input) { prompt = input.systemPrompt; return { text: 'Я ассистент Юрия. Что вас интересует?' }; } }, [], false, 'ru');
  assert.ok(prompt.includes(SHORT_REPLY_RULES));
  assert.match(prompt, /одной короткой фразой/);
  assert.doesNotMatch(prompt, /2–4 предложениями/);
});
