/** Starter "what to find out" sets by business sector; the owner edits the list in the cabinet. */
export type DiscoverySet = 'beauty' | 'business' | 'food' | 'other';
type Lang = 'ru' | 'he' | 'en';

export const DISCOVERY_SECTOR_KEYWORDS: Record<Exclude<DiscoverySet, 'other'>, RegExp> = {
  beauty: /космет|парикмах|маникюр|педикюр|ногт|массаж|бров|ресниц|визаж|эпиляц|салон|барбер|spa|спа|beauty|cosmet|hair|nail|massage|brow|lash|makeup|salon|barber|קוסמט|ספר|מספרה|ציפורנ|מניקור|עיסוי|גבות|ריסים|איפור|יופי/i,
  business: /автоматиз|бухгалт|маркетинг|реклам|it\b|айти|разработ|программ|консалт|юрист|smm|crm|сайт|автоматизац|account|bookkeep|marketing|advertis|software|developer|consult|lawyer|automation|website|אוטומצי|הנהלת חשבונות|רואה חשבון|שיווק|פרסום|פיתוח|תוכנה|ייעוץ|עורך דין|אתר/i,
  food: /повар|кейтер|кондит|ресторан|кафе|выпечк|торт|кухн|еда|пекар|chef|cook|cater|pastry|bakery|cake|restaurant|cafe|food|שף|קייטרינג|קונדיטור|מסעדה|בית קפה|מאפ|עוגות|אוכל/i,
};

export const DISCOVERY_DEFAULTS: Record<DiscoverySet, Record<Lang, string[]>> = {
  beauty: {
    ru: ['Какая процедура интересует или с какой задачей хотите поработать?', 'Делали ли раньше эту процедуру, впервые ли у нас?', 'Когда удобно прийти: день, утро или вечер?', 'Как узнали о нас?'],
    he: ['איזה טיפול מעניין אותך או עם איזו מטרה תרצה לעבוד?', 'עשית את הטיפול הזה בעבר? זו הפעם הראשונה אצלנו?', 'מתי נוח לך להגיע: איזה יום, בוקר או ערב?', 'איך שמעת עלינו?'],
    en: ['Which treatment are you interested in, or what would you like to work on?', 'Have you had this treatment before, is it your first time with us?', 'When is it convenient to come: which day, morning or evening?', 'How did you hear about us?'],
  },
  business: {
    ru: ['Чем занимается бизнес и сколько в нём человек?', 'Откуда приходят клиенты: WhatsApp, Instagram, сайт, рекомендации?', 'Что сейчас отнимает больше всего времени?', 'Какими системами уже пользуетесь: таблицы, CRM или ничего?'],
    he: ['במה עוסק העסק וכמה אנשים עובדים בו?', 'מאיפה מגיעים הלקוחות: WhatsApp, Instagram, אתר, המלצות?', 'מה לוקח היום הכי הרבה זמן?', 'באילו מערכות אתם כבר משתמשים: טבלאות, CRM או כלום?'],
    en: ['What does the business do and how many people work in it?', 'Where do clients come from: WhatsApp, Instagram, website, referrals?', 'What takes the most time right now?', 'Which systems do you already use: spreadsheets, a CRM, nothing?'],
  },
  food: {
    ru: ['На какое событие и на сколько человек?', 'На какую дату?', 'Есть ли ограничения в питании?', 'Доставка или самовывоз?'],
    he: ['לאיזה אירוע ולכמה אנשים?', 'לאיזה תאריך?', 'יש הגבלות תזונתיות?', 'משלוח או איסוף עצמי?'],
    en: ['What is the occasion and for how many people?', 'For which date?', 'Any dietary restrictions?', 'Delivery or pickup?'],
  },
  other: {
    ru: ['Что именно интересует?', 'Для какой задачи или ситуации?', 'Когда нужно?'],
    he: ['מה בדיוק מעניין אותך?', 'לאיזו מטרה או מצב?', 'מתי צריך?'],
    en: ['What exactly are you interested in?', 'For what task or situation?', 'When do you need it?'],
  },
};

export const DISCOVERY_MAX_QUESTIONS = 10;
export const DISCOVERY_MAX_CHARS = 200;
export const CLIENT_PROFILE_MAX_CHARS = 2000;
/** Replies closer than this (share of characters changed) to the previous bot message count as a repeat. */
export const REPEAT_SIMILARITY_THRESHOLD = 0.15;

export function discoverySet(sector: string | null | undefined): DiscoverySet {
  const value = sector ?? '';
  for (const [set, pattern] of Object.entries(DISCOVERY_SECTOR_KEYWORDS)) if (pattern.test(value)) return set as DiscoverySet;
  return 'other';
}

export function discoveryQuestions(stored: unknown, sector: string | null | undefined, language: string): string[] {
  const list = Array.isArray(stored) ? stored.filter((q): q is string => typeof q === 'string' && q.trim().length > 0) : [];
  if (list.length) return list.slice(0, DISCOVERY_MAX_QUESTIONS);
  const lang: Lang = language === 'he' || language === 'en' ? language : 'ru';
  return DISCOVERY_DEFAULTS[discoverySet(sector)][lang];
}
