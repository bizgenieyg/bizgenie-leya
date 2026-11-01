import assert from 'node:assert/strict';
import test from 'node:test';
import { TEMPLATE_DEFAULTS } from '../config/templates.js';
import { OWNER_TOPICS } from '../config/owner-channels.js';
import { OWNER_MESSAGE_PROMPT } from '../config/owner-rules.js';
import { welcomeTemplate } from './owner-channels.service.js';

/** Z16: every owner message that needs an action ends with how to answer — in each language. */
const HOW_TO_ANSWER: Record<string, Record<'ru' | 'he' | 'en', RegExp>> = {
  reply: { ru: /Ответьте реплеем — (я )?передам клиенту\.$/, he: /אעביר ללקוח\.$/, en: /I'll pass it to the client\.$/ },
  yesNo: { ru: /Да \/ Нет$/, he: /כן \/ לא$/, en: /Yes \/ No$/ },
  start: { ru: /напишите „включи“/, he: /כתבו „הפעל“/, en: /write “start”/ },
  clarify: { ru: /Ответьте реплеем, если нужно уточнить\.$/, he: /השיבו בציטוט אם צריך לברר\.$/, en: /Reply to this message if you need to clarify\.$/ },
};
const ACTION_TEMPLATES: Record<string, keyof typeof HOW_TO_ANSWER> = {
  'owner.escalation': 'reply', 'owner.request': 'reply', 'owner.request_card': 'reply', 'owner.remind': 'reply', 'owner.remind_request': 'reply',
  'owner.setting_confirm': 'yesNo', 'owner.support_offer': 'yesNo', 'owner.rule_understood': 'yesNo', 'owner.rule_edit_understood': 'yesNo',
  'owner.rule_remove_understood': 'yesNo', 'owner.rule_conflict': 'yesNo', 'owner.fact_understood': 'yesNo', 'owner.fact_rule_understood': 'yesNo', 'owner.remember_offer': 'yesNo',
  'owner.paused_all': 'start', 'owner.paused_line': 'start', 'owner.support_answer': 'clarify',
};

test('Z16: owner messages that need an action end with how to answer (ru/he/en)', () => {
  for (const [key, kind] of Object.entries(ACTION_TEMPLATES)) for (const l of ['ru', 'he', 'en'] as const)
    assert.match(TEMPLATE_DEFAULTS[key]![l]!.trim(), HOW_TO_ANSWER[kind]![l], `${key} ${l}`);
});

test('Z16: a topic cannot be on without its welcome — name, description and the first message in ru/he/en', () => {
  for (const topic of OWNER_TOPICS) for (const key of [`owner.channel_${topic}`, `owner.channel_${topic}_description`, welcomeTemplate(topic)])
    for (const l of ['ru', 'he', 'en']) assert.ok(TEMPLATE_DEFAULTS[key]?.[l]?.trim(), `${key} ${l}`);
});

test('Z16: an owner rule to act as another business is refused (core over rules)', () => {
  assert.match(OWNER_MESSAGE_PROMPT, /нельзя сохранить[^\n]*отвечать за другой бизнес/);
});

test('Z16 review: a stored copy of a former default does not hide the new «how to answer» line; a real edit stays', async () => {
  const { LEGACY_TEMPLATE_DEFAULTS } = await import('../config/templates.js');
  const { renderText } = await import('./templates.service.js');
  for (const key of ['owner.support_answer', 'owner.remind', 'owner.remind_request', 'owner.rules_full']) {
    const olds = LEGACY_TEMPLATE_DEFAULTS[key] ?? [];
    for (const language of ['ru', 'he', 'en'] as const) {
      const old = olds.find(t => TEMPLATE_DEFAULTS[key]![language] !== t && (language === 'he' ? /[א-ת]/.test(t) : language === 'ru' ? /[а-я]/i.test(t) : !/[א-תа-я]/i.test(t)));
      assert.ok(old, `${key}.${language}`);
      const settings = { templates: { [key]: { [language]: old } } } as never;
      assert.equal(renderText(settings, key, language), renderText(undefined, key, language), `${key}.${language}`);
    }
  }
  const edited = { templates: { 'owner.support_answer': { ru: 'Юрий ответил: «{text}»' } } } as never;
  assert.equal(renderText(edited, 'owner.support_answer', 'ru', { text: 'ок' }), 'Юрий ответил: «ок»');
});

test('Z16 review: the demo tenant may keep a rule about showing another business; others may not', async () => {
  const { ownerMessagePrompt } = await import('../config/owner-rules.js');
  assert.match(ownerMessagePrompt(false), /отвечать за другой бизнес/);
  assert.doesNotMatch(ownerMessagePrompt(true), /другим бизнесом|другой бизнес/);
});
