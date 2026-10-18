/**
 * Task Z6: one scheme for every business — core + the template of its deal type + its facts. The template key
 * comes from the operator setting instruction_template; empty → derived from business_sector here; no match →
 * 'general'. Texts of the templates are data (evals/instructions/templates/<key>.md), published by the operator.
 */
export const TEMPLATE_KEYS = ['service_booking', 'order', 'project', 'b2b', 'general'] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];
export const isTemplateKey = (value: unknown): value is TemplateKey => typeof value === 'string' && (TEMPLATE_KEYS as readonly string[]).includes(value);

/**
 * Sector → template. The cabinet's sector suggestions (ru/he/en, `businessSectorSuggestions`) first, then keywords:
 * a sector matches when it contains a keyword (case-insensitive). The first template whose keyword matches wins.
 */
export const SECTOR_TEMPLATE_KEYWORDS: Array<{ template: Exclude<TemplateKey, 'general'>; keywords: string[] }> = [
  { template: 'service_booking', keywords: [
    'косметолог', 'парикмахер', 'маникюр', 'педикюр', 'ногт', 'бров', 'ресниц', 'салон', 'барбер', 'массаж', 'тренер', 'фитнес', 'йога', 'клиник', 'стоматолог', 'врач', 'психолог', 'репетитор', 'учител', 'курс', 'мастер красоты',
    'קוסמטיק', 'מעצב שיער', 'מספרה', 'ציפורניים', 'מניקור', 'פדיקור', 'גבות', 'ריסים', 'מכון', 'עיסוי', 'מאמן', 'כושר', 'יוגה', 'קליניקה', 'רופא', 'שיניים', 'פסיכולוג', 'מורה',
    'cosmetolog', 'hairdress', 'barber', 'nail', 'manicur', 'pedicur', 'brow', 'lash', 'salon', 'spa', 'massage', 'trainer', 'fitness', 'yoga', 'clinic', 'dentist', 'doctor', 'therap', 'tutor', 'teacher', 'lesson'] },
  { template: 'order', keywords: [
    'ресторан', 'кафе', 'магазин', 'еда', 'повар', 'кухн', 'кейтеринг', 'кондитер', 'торт', 'выпечк', 'пекар', 'цвет', 'букет', 'доставк', 'на заказ', 'одежд', 'изделия',
    'מסעדה', 'בית קפה', 'קפה', 'חנות', 'אוכל', 'שף', 'מטבח', 'קייטרינג', 'קונדיטור', 'עוגות', 'מאפ', 'פרחים', 'משלוח', 'בגדים',
    'restaurant', 'café', 'cafe', 'shop', 'store', 'food', 'chef', 'cook', 'kitchen', 'catering', 'bakery', 'baker', 'cake', 'pastry', 'flower', 'florist', 'delivery', 'boutique'] },
  { template: 'project', keywords: [
    'риелтор', 'недвижим', 'ремонт', 'строит', 'дизайн', 'интерьер', 'сантехник', 'электрик', 'мастер на выезд', 'мероприят', 'свадьб', 'фотограф', 'видеограф', 'переезд',
    'מתווך', 'נדל', 'שיפוצ', 'בנייה', 'עיצוב', 'אינסטלטור', 'חשמלאי', 'אירועים', 'חתונ', 'צלם', 'הובלות',
    'real estate', 'realtor', 'renovat', 'construct', 'interior', 'design', 'plumb', 'electrician', 'handyman', 'event', 'wedding', 'photograph', 'video', 'moving'] },
  { template: 'b2b', keywords: [
    'консалт', 'консультант', 'агентств', 'маркетинг', 'реклам', 'бухгалт', 'юрист', 'адвокат', 'it', 'разработк', 'программ', 'автоматизац', 'для бизнеса',
    'ייעוץ', 'יועץ', 'סוכנות', 'שיווק', 'פרסום', 'הנהלת חשבונות', 'רואה חשבון', 'עורך דין', 'פיתוח', 'תוכנה', 'אוטומציה',
    'consult', 'agency', 'marketing', 'advertis', 'accountant', 'bookkeep', 'lawyer', 'legal', 'software', 'developer', 'automation', 'b2b', 'saas'] },
];

/** The template of a sector; 'general' when nothing matches (also for an empty sector). */
export function templateForSector(sector: string | null | undefined): TemplateKey {
  const text = (sector ?? '').toLocaleLowerCase().trim();
  if (!text) return 'general';
  // Whole word for very short Latin keywords (it), substring otherwise.
  const hit = (k: string) => k.length <= 2 ? new RegExp(`(^|[^\\p{L}])${k}([^\\p{L}]|$)`, 'u').test(text) : text.includes(k.toLocaleLowerCase());
  return SECTOR_TEMPLATE_KEYWORDS.find(r => r.keywords.some(hit))?.template ?? 'general';
}

/** Onboarding check in the simulator: three typical client questions per template (+ «Свой вопрос» in the cabinet). */
export const SIMULATOR_SUGGESTIONS: Record<TemplateKey, Record<'ru' | 'he' | 'en', [string, string, string]>> = {
  service_booking: {
    ru: ['Сколько стоит и сколько длится процедура?', 'Можно записаться на эту неделю?', 'Где вы принимаете?'],
    he: ['כמה עולה הטיפול וכמה זמן הוא נמשך?', 'אפשר לקבוע תור לשבוע הזה?', 'איפה אתם מקבלים?'],
    en: ['How much is it and how long does it take?', 'Can I book for this week?', 'Where are you located?'],
  },
  order: {
    ru: ['Что можно заказать и сколько это стоит?', 'Можно заказать на завтра?', 'Есть доставка?'],
    he: ['מה אפשר להזמין וכמה זה עולה?', 'אפשר להזמין למחר?', 'יש משלוח?'],
    en: ['What can I order and how much is it?', 'Can I order for tomorrow?', 'Do you deliver?'],
  },
  project: {
    ru: ['Сколько примерно будет стоить?', 'Когда вы можете начать?', 'Можно сначала посмотреть примеры работ?'],
    he: ['כמה זה יעלה בערך?', 'מתי אפשר להתחיל?', 'אפשר לראות קודם דוגמאות של עבודות?'],
    en: ['Roughly how much would it cost?', 'When can you start?', 'Can I see examples of your work first?'],
  },
  b2b: {
    ru: ['Чем вы можете помочь моему бизнесу?', 'Сколько стоят ваши услуги?', 'Как начать работать с вами?'],
    he: ['איך אתם יכולים לעזור לעסק שלי?', 'כמה עולים השירותים שלכם?', 'איך מתחילים לעבוד איתכם?'],
    en: ['How can you help my business?', 'How much do your services cost?', 'How do we start working together?'],
  },
  general: {
    ru: ['Чем вы занимаетесь?', 'Сколько это стоит?', 'Как с вами связаться?'],
    he: ['במה אתם עוסקים?', 'כמה זה עולה?', 'איך אפשר ליצור איתכם קשר?'],
    en: ['What do you do?', 'How much does it cost?', 'How can I reach you?'],
  },
};
