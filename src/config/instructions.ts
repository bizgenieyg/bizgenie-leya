/** Task Z configuration that is data, not code. */
export const CORE_CONFIG_KEY = 'assistant_core_instruction';
/** Placeholders the core and business instructions may use; an empty value blocks the reply. */
export const INSTRUCTION_PLACEHOLDERS = ['business_name', 'owner_name'] as const;
/** In demo mode the first number needs one of these nearby (this or an earlier demo reply). */
export const DEMO_EXAMPLE_MARKERS: readonly string[] = ['для примера', 'например', 'условн', 'לדוגמה', 'לשם הדוגמה', 'לצורך הדוגמה', 'for example', 'as an example', 'e.g.'];
/** Owner replies that postpone an interview question. */
export const INTERVIEW_POSTPONE_WORDS: readonly string[] = ['пропустить', 'пропусти', 'не знаю', 'потом', 'позже', 'не сейчас', 'дальше', 'לדלג', 'דלג', 'לא יודע', 'לא יודעת', 'אחר כך', 'אחר-כך', 'skip', "don't know", 'dont know', 'later', 'not now'];
/** Client turns during which a direct request still counts for a REQUEST collected over several messages. */
export const REQUEST_INTENT_TURNS = 6;

/** Owner-interview questions for empty required topics of the sector (task Z), in the owner's language. */
export const GAP_QUESTIONS: Record<string, Record<'ru' | 'he' | 'en', string>> = {
  services_prices: { ru: 'Что вы продаёте и сколько это стоит? Перечислите основные услуги или товары с ценами.', he: 'מה אתם מוכרים וכמה זה עולה? פרטו את השירותים או המוצרים העיקריים עם מחירים.', en: 'What do you sell and how much does it cost? List the main services or products with prices.' },
  location_hours: { ru: 'Где вы находитесь или куда приезжаете, и в какие дни и часы работаете?', he: 'איפה אתם נמצאים או לאן אתם מגיעים, ובאילו ימים ושעות אתם עובדים?', en: 'Where are you located or where do you travel, and on which days and hours do you work?' },
  booking: { ru: 'Как клиенту записаться или заказать, и когда нужно звать вас лично?', he: 'איך לקוח קובע תור או מזמין, ומתי צריך לערב אתכם אישית?', en: 'How does a client book or order, and when should you be called in personally?' },
  faq: { ru: 'Какие вопросы клиенты задают чаще всего и что вы на них отвечаете?', he: 'אילו שאלות לקוחות שואלים הכי הרבה ומה אתם עונים?', en: 'Which questions do clients ask most often, and what do you answer?' },
  payment_cancel: { ru: 'Как клиенты оплачивают, нужна ли предоплата и какие правила отмены?', he: 'איך לקוחות משלמים, האם צריך מקדמה ומה כללי הביטול?', en: 'How do clients pay, is a deposit needed, and what are the cancellation rules?' },
  why_us: { ru: 'Почему клиенты выбирают именно вас? Что вы делаете иначе, чем другие?', he: 'למה לקוחות בוחרים דווקא בכם? מה אתם עושים אחרת?', en: 'Why do clients choose you? What do you do differently?' },
};
/** Topics a business cannot start without: asked first ("что продаём, цены, как записаться, когда звать владельца"). */
export const LAUNCH_TOPICS: readonly string[] = ['services_prices', 'booking'];
