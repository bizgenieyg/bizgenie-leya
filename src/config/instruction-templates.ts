/**
 * Task Z6: one scheme for every business — core + the template of its deal type + its facts. The template key
 * comes from the operator setting instruction_template; empty → derived from business_sector here; no match →
 * 'general'. Texts of the templates are data (evals/instructions/templates/<key>.md), published by the operator.
 */
export const TEMPLATE_KEYS = ['service_booking', 'order', 'project', 'b2b', 'general'] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];
export const isTemplateKey = (value: unknown): value is TemplateKey => typeof value === 'string' && (TEMPLATE_KEYS as readonly string[]).includes(value);

/**
 * Z8: the sector suggestions of the cabinet (onboarding step 1 and «Настройки → Бизнес»), grouped, in ru/he/en, with
 * the template of each. Same texts as `businessSectorGroups` in the cabinet dictionaries; a suggestion picked as is
 * gives exactly this template. Free input goes through the keywords below.
 */
export const SECTOR_SUGGESTIONS: Array<{ group: string; template: TemplateKey; items: Array<Record<'ru' | 'he' | 'en', string>> }> = [
  { group: 'beauty_health', template: 'service_booking', items: [
    { ru: 'косметолог', he: 'קוסמטיקאית', en: 'cosmetologist' }, { ru: 'парикмахер', he: 'מעצב/ת שיער', en: 'hairdresser' },
    { ru: 'мастер маникюра', he: 'מניקוריסטית', en: 'nail technician' }, { ru: 'брови и ресницы', he: 'גבות וריסים', en: 'brows and lashes' },
    { ru: 'массаж', he: 'עיסוי', en: 'massage' }, { ru: 'барбер', he: 'ברבר', en: 'barber' }, { ru: 'врач / клиника', he: 'רופא / קליניקה', en: 'doctor / clinic' },
    { ru: 'стоматолог', he: 'רופא שיניים', en: 'dentist' }, { ru: 'психолог', he: 'פסיכולוג/ית', en: 'psychologist' },
    { ru: 'фитнес-тренер', he: 'מאמן/ת כושר', en: 'fitness trainer' }, { ru: 'йога', he: 'יוגה', en: 'yoga' }] },
  { group: 'education', template: 'service_booking', items: [
    { ru: 'репетитор', he: 'מורה פרטי', en: 'tutor' }, { ru: 'курсы', he: 'קורסים', en: 'courses' }, { ru: 'детские кружки', he: 'חוגים לילדים', en: 'kids clubs' }] },
  { group: 'food', template: 'order', items: [
    { ru: 'домашний повар', he: 'שף ביתי', en: 'home cook' }, { ru: 'кондитер / торты', he: 'קונדיטוריה / עוגות', en: 'cakes and pastry' },
    { ru: 'кейтеринг', he: 'קייטרינג', en: 'catering' }, { ru: 'ресторан', he: 'מסעדה', en: 'restaurant' }, { ru: 'кафе', he: 'בית קפה', en: 'café' }] },
  { group: 'retail', template: 'order', items: [
    { ru: 'магазин', he: 'חנות', en: 'shop' }, { ru: 'цветы', he: 'פרחים', en: 'flowers' }, { ru: 'одежда', he: 'בגדים', en: 'clothing' },
    { ru: 'изделия на заказ', he: 'מוצרים בהזמנה אישית', en: 'custom-made goods' }, { ru: 'интернет-магазин', he: 'חנות אונליין', en: 'online store' },
    // Z11: rentals of things are orders (what is taken + dates); housing rentals stay 'general'.
    { ru: 'аренда оборудования', he: 'השכרת ציוד', en: 'equipment rental' }, { ru: 'аренда автомобилей', he: 'השכרת רכב', en: 'car rental' }] },
  { group: 'projects', template: 'project', items: [
    { ru: 'ремонт', he: 'שיפוצים', en: 'renovation' }, { ru: 'сантехник', he: 'אינסטלטור', en: 'plumber' }, { ru: 'электрик', he: 'חשמלאי', en: 'electrician' },
    { ru: 'мебель на заказ', he: 'רהיטים בהזמנה', en: 'custom furniture' }, { ru: 'дизайн интерьера', he: 'עיצוב פנים', en: 'interior design' },
    { ru: 'фотограф', he: 'צלם/ת', en: 'photographer' }, { ru: 'организация мероприятий', he: 'הפקת אירועים', en: 'event planning' }] },
  { group: 'business', template: 'b2b', items: [
    { ru: 'автоматизация бизнеса', he: 'אוטומציה לעסקים', en: 'business automation' }, { ru: 'бухгалтер', he: 'הנהלת חשבונות', en: 'accountant' },
    { ru: 'юрист', he: 'עורך/ת דין', en: 'lawyer' }, { ru: 'маркетинг', he: 'שיווק', en: 'marketing' }, { ru: 'IT-услуги', he: 'שירותי IT', en: 'IT services' }] },
  { group: 'other', template: 'general', items: [
    { ru: 'риелтор', he: 'מתווך/ת נדל״ן', en: 'realtor' }, { ru: 'страховой агент', he: 'סוכן/ת ביטוח', en: 'insurance agent' },
    { ru: 'туризм', he: 'תיירות', en: 'travel and tourism' }, { ru: 'аренда жилья', he: 'השכרת דירות', en: 'housing rental' },
    { ru: 'автосервис', he: 'מוסך', en: 'car service' }, { ru: 'ветеринар', he: 'וטרינר', en: 'veterinarian' }, { ru: 'уборка', he: 'ניקיון', en: 'cleaning' }] },
];
const normalizeSector = (sector: string) => sector.toLocaleLowerCase().replace(/[״"]/g, '"').replace(/\s+/g, ' ').trim();
const SUGGESTED = new Map(SECTOR_SUGGESTIONS.flatMap(g => g.items.flatMap(i => Object.values(i).map(v => [normalizeSector(v), g.template] as const))));

/**
 * Free input → template: a sector matches when it contains a keyword (case-insensitive). The first template whose
 * keyword matches wins. Sectors of the «Прочее» group (realtor, insurance, tourism, rentals, car service, vet,
 * cleaning) have no keywords on purpose: they go to 'general' (Z11: equipment and car rentals moved to 'order'; housing rentals stay).
 */
export const SECTOR_TEMPLATE_KEYWORDS: Array<{ template: Exclude<TemplateKey, 'general'>; keywords: string[] }> = [
  { template: 'service_booking', keywords: [
    'косметолог', 'парикмахер', 'маникюр', 'педикюр', 'ногт', 'бров', 'ресниц', 'салон', 'барбер', 'массаж', 'тренер', 'фитнес', 'йога', 'клиник', 'стоматолог', 'врач', 'психолог', 'репетитор', 'учител', 'курс', 'кружк', 'секци', 'мастер красоты',
    'קוסמטיק', 'מעצב שיער', 'מעצב/ת שיער', 'שיער', 'מספרה', 'ציפורניים', 'מניקור', 'פדיקור', 'גבות', 'ריסים', 'מכון', 'עיסוי', 'ברבר', 'מאמן', 'כושר', 'יוגה', 'קליניקה', 'רופא', 'שיניים', 'פסיכולוג', 'מורה', 'קורס', 'חוג',
    'cosmetolog', 'hairdress', 'barber', 'nail', 'manicur', 'pedicur', 'brow', 'lash', 'salon', 'spa', 'massage', 'trainer', 'fitness', 'yoga', 'clinic', 'dentist', 'doctor', 'therap', 'psycholog', 'tutor', 'teacher', 'lesson', 'course', 'kids club'] },
  { template: 'order', keywords: [
    'аренда оборуд', 'аренда авто', 'прокат', 'השכרת ציוד', 'השכרת רכב', 'equipment rental', 'car rental', 'car hire',
    'ресторан', 'кафе', 'магазин', 'еда', 'повар', 'кухн', 'кейтеринг', 'кондитер', 'торт', 'выпечк', 'пекар', 'цвет', 'букет', 'доставк', 'одежд', 'изделия', 'изделий',
    'מסעדה', 'בית קפה', 'קפה', 'חנות', 'אוכל', 'שף', 'מטבח', 'קייטרינג', 'קונדיטור', 'עוגות', 'מאפ', 'פרחים', 'משלוח', 'בגדים', 'בהזמנה אישית',
    'restaurant', 'café', 'cafe', 'shop', 'store', 'food', 'chef', 'cook', 'kitchen', 'catering', 'bakery', 'baker', 'cake', 'pastry', 'flower', 'florist', 'delivery', 'boutique', 'cloth', 'custom-made', 'handmade'] },
  { template: 'project', keywords: [
    'ремонт', 'строит', 'дизайн', 'интерьер', 'сантехник', 'электрик', 'мебел', 'мастер на выезд', 'мероприят', 'свадьб', 'фотограф', 'видеограф', 'переезд',
    'שיפוצ', 'בנייה', 'עיצוב', 'אינסטלטור', 'חשמלאי', 'רהיט', 'אירועים', 'חתונ', 'צלם', 'הובלות',
    'renovat', 'construct', 'interior', 'design', 'plumb', 'electrician', 'furniture', 'handyman', 'event', 'wedding', 'photograph', 'video', 'moving'] },
  { template: 'b2b', keywords: [
    'консалт', 'консультант', 'агентств', 'маркетинг', 'реклам', 'бухгалт', 'юрист', 'адвокат', 'it', 'разработк', 'программ', 'автоматизац', 'для бизнеса',
    'ייעוץ', 'יועץ', 'סוכנות', 'שיווק', 'פרסום', 'הנהלת חשבונות', 'רואה חשבון', 'עורך דין', 'עורך/ת דין', 'פיתוח', 'תוכנה', 'אוטומציה',
    'consult', 'agency', 'marketing', 'advertis', 'accountant', 'bookkeep', 'lawyer', 'legal', 'software', 'developer', 'automation', 'b2b', 'saas'] },
];

/** The template of a sector: a suggestion as is → its template; else keywords; 'general' when nothing matches. */
export function templateForSector(sector: string | null | undefined): TemplateKey {
  const text = normalizeSector(sector ?? '');
  if (!text) return 'general';
  const suggested = SUGGESTED.get(text);
  if (suggested) return suggested;
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
