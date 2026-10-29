/** Task Z configuration that is data, not code. */
export const CORE_CONFIG_KEY = 'assistant_core_instruction';
/** Placeholders the core and business instructions may use; an empty value blocks the reply. */
export const INSTRUCTION_PLACEHOLDERS = ['business_name', 'owner_name', 'assistant_name'] as const;
/** Z8: {assistant_name} when the owner left the name empty (assistant_profiles.assistant_name). */
export const ASSISTANT_NAME_DEFAULT = 'Лея';
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
/** Z8: an operator question → the same question in ru/he/en for the owner (one task-model call per question, stored). */
export const QUESTION_TRANSLATE_PROMPT = 'Переведи вопрос владельцу бизнеса на русский, иврит и английский. Смысл не меняй, ничего не добавляй, обращение на «вы» / во множественном числе. Верни строго JSON: {"ru": "...", "he": "...", "en": "..."}';
/** Topics a business cannot start without: asked first ("что продаём, цены, как записаться, когда звать владельца"). */
export const LAUNCH_TOPICS: readonly string[] = ['services_prices', 'booking'];

/** Z12 (as chef-bot prompts/sales.js): what the reply model is told about this moment of this dialog. Prompt text,
 *  not client text: the core is Russian. {…} are filled by the engine. */
export const PROMPT_BLOCKS = {
  today: 'Сегодня {weekday}, {date} (время бизнеса).',
  knownName: 'ИЗВЕСТНОЕ ИМЯ КЛИЕНТА (из WhatsApp): {name}. Если оно похоже на настоящее имя человека (в том числе «Имя Фамилия») — обращайся к клиенту только по имени, без фамилии, и не спрашивай имя повторно. Если имя написано латиницей, а разговор идёт по-русски, — пиши его привычным русским написанием («Olga» → «Ольга»); на иврите — ивритским. Если это явно не имя человека (название бизнеса, эмодзи, ник) — не используй его и спроси имя обычным вопросом, когда оно понадобится.',
  openQuestions: 'ОТКРЫТЫЕ ВОПРОСЫ К {owner_name} ПО ЭТОМУ КЛИЕНТУ — ждёшь ответа на:\n{items}',
  noOpenQuestions: 'ОТКРЫТЫЕ ВОПРОСЫ К {owner_name} ПО ЭТОМУ КЛИЕНТУ: открытых вопросов нет — все ответы переданы.',
  openQuestionsRule: 'Говори, что ждёшь ответа от {owner_name}, только если вопрос есть в этом списке. Если списка нет — не упоминай ожидание, даже если раньше в диалоге обещала уточнить: значит ответ уже передан. Не перечисляй по истории переписки вопросы как «висящие».',
  quietHours: 'Сейчас {owner_name} не на связи и отвечает с {until}. Если нужен ответ {owner_name}, скажи клиенту, что уточнишь и {owner_name} ответит с {until}.',
  voice: 'ПОСЛЕДНЕЕ СООБЩЕНИЕ КЛИЕНТА БЫЛО ГОЛОСОВЫМ (расшифровано автоматически, возможны ошибки). Сначала коротко переспроси суть: «Правильно поняла: {суть в 1–2 предложениях}?» — не повторяй расшифровку дословно. По существу отвечай после подтверждения клиента.',
};
export const WEEKDAYS_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
/** Z12 (as chef-bot intentRouter.js): the role classifier; the answer is one word. */
export const ROLE_CLASSIFIER_PROMPT = `Ты классификатор намерений для WhatsApp-ассистента малого бизнеса.
Определи, к какой категории относится последнее сообщение клиента:

SALES — клиент хочет купить, записаться, заказать, спрашивает про услуги, цены, условия, или это обычное первое обращение.
SUPPORT — клиент пишет про УЖЕ существующий заказ, запись или подключение: статус, жалобу, просьбу изменить, отменить или перенести, проблему.

Ответь ОДНИМ словом: SALES или SUPPORT.`;
/** Z12 (as chef-bot nataliaReplyFormatter.js): an owner answer is either the answer or a postponement. */
export const OWNER_REPLY_CLASSIFIER_PROMPT = 'Это ответ по существу на вопрос клиента или отсрочка/отговорка (например «позже», «завтра отвечу», «спокойной ночи», «занят сейчас»)? Ответь одним словом: ANSWER или DEFER.';
/** The line before the owner's verbatim answer and the assistant's short follow-up. {…} filled by the code. */
export const OWNER_FORWARD_PROMPT = `Ты — {assistant_name}, ассистент бизнеса «{business_name}». Владелец — {owner_name}.
Клиенту уйдёт сообщение: «<вступление>:\\n\\n«<ответ владельца дословно>»\\n\\n<реплика>».
Верни строго JSON: {"intro": "...", "follow_up": "..."}
- intro — на языке клиента ({language}): «Уточнила у <имя владельца в нужном падеже> насчёт <тема вопроса в 5–8 словах, в винительном падеже>», без двоеточия и кавычек. На иврите: «בדקתי עם <имя> לגבי <тема>»; на английском: «I checked with <имя> about <тема>».
- follow_up — {follow_up_rule}
Пиши на «вы», без длинного тире, ответ владельца не повторяй.`;
export const OWNER_FORWARD_FOLLOW_UP = 'короткая реплика клиенту от тебя, 1–3 предложения, на языке клиента: отказ или «нет» — посочувствуй и предложи похожее из Фактов; согласие или «да» — подтверди и предложи следующий шаг; неясно — мягко спроси, что именно интересует.';
export const OWNER_FORWARD_NO_FOLLOW_UP = 'пустая строка "".';
/** Z12 (as chef-bot dailyReport.js) + the operator's control: one call per tenant over yesterday's dialogs. */
export const DAILY_REVIEW_PROMPT = `Ты разбираешь вчерашние диалоги WhatsApp-ассистента малого бизнеса с клиентами. Ниже — Факты бизнеса и диалоги (у каждого id).
Верни строго JSON:
{"dialogs": [{"id": "<id диалога>", "summary": "суть обращения в 5–10 словах, без имён и телефонов", "outcome": "request" | "lost" | "in_progress" | "info_only", "reason": "price" | "date" | "missing" | "silent" | "other" | null}],
 "findings": [{"id": "<id диалога>", "kind": "price_not_in_facts" | "term_not_in_facts" | "promise_for_owner" | "contradicts_facts" | "other", "reply_excerpt": "отрывок ответа ассистента до 200 знаков, без имён и телефонов", "note": "что не так, коротко"}]}
- outcome: request — клиент оставил заявку; lost — клиент ушёл или отказался (reason: price — дорого, date — не подошла дата, missing — нет нужного, silent — ушёл молча, other — другое); in_progress — разговор не закончен; info_only — клиент только узнал информацию.
- findings — только сомнительные ответы АССИСТЕНТА: цена или срок, которых нет в Фактах; обещание от имени владельца (время, скидка, результат); противоречие Фактам. Нет таких — пустой список.
- По каждому диалогу из списка — ровно одна запись в dialogs.
- summary пиши на языке: {language} (отчёт читает владелец); note — по-русски (для оператора).`;
