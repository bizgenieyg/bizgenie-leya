/**
 * Z11: the owner's rules and corrections from WhatsApp («Нужен ответ») and the cabinet. Data, not code: the words
 * that mean «да» / «нет» and the prompt of the task model that understands an owner message.
 */
export const RULE_YES_WORDS: readonly string[] = ['да', 'ага', 'сохранить', 'сохрани', 'верно', '1', 'yes', 'y', 'ok', 'okay', 'save', 'correct', 'כן', 'נכון', 'שמור', 'שמרי', '👍', '✅'];
export const RULE_NO_WORDS: readonly string[] = ['нет', 'не надо', 'не сохраняй', 'отмена', '2', 'no', 'nope', 'cancel', 'לא', 'לא צריך', 'ביטול', '👎', '❌'];

/** A rule that names a price, a date, hours or a time is a fact, not a rule (checked in code as well as by the model). */
export const FACT_LIKE_RULE = /(\d[\d\s]*\s*(₪|шек|шекел|nis|ils|\$|€|руб|ש["״]?ח|שקל))|(\b\d{1,2}[:.]\d{2}\b)|(\b\d{1,2}[./]\d{1,2}([./]\d{2,4})?\b)|(\bс\s*\d{1,2}\s*(до|-|–)\s*\d{1,2}\b)|(\bfrom\s*\d{1,2}\s*(to|-|–)\s*\d{1,2}\b)|(\bמ[-־]?\s*\d{1,2}\s*עד\s*\d{1,2}\b)/i;

export const OWNER_MESSAGE_KINDS = ['add_rule', 'edit_rule', 'remove_rule', 'list_rules', 'undo', 'fact', 'question', 'other'] as const;
export type OwnerMessageKind = (typeof OWNER_MESSAGE_KINDS)[number];

/** The task model reads one owner message (with the current rules and facts) and returns JSON. */
export const OWNER_MESSAGE_PROMPT = `Ты разбираешь сообщение владельца бизнеса своему ИИ-ассистенту в WhatsApp.
Владелец может: добавить правило поведения ассистента, изменить правило N, убрать правило N, попросить показать правила, отменить последнее изменение, сообщить факт о бизнесе, задать вопрос или написать что-то другое.

Правило — как ассистенту вести себя с клиентами («город не спрашивай», «в субботу не предлагай запись», «всегда предлагай абонемент»). Правило не содержит цен, дат, часов, адресов и других данных — такие сообщения это факт.
Факт — данные о бизнесе (цены, адрес, часы, условия, услуги). Тема факта — одна из: services_prices, location_hours, booking, faq, payment_cancel, why_us, about, other.

Правило формулируй коротко, до 300 знаков, на языке владельца, как указание ассистенту, без «пожалуйста».
Правило нельзя сохранить, если оно требует обманывать клиента, выдавать себя за человека или за владельца, придумывать цены и данные, которых нет в фактах, дискриминировать, обещать результат для здоровья или нарушать закон. Тогда заполни conflict: причина простыми словами и допустимый вариант правила.
Если правило опирается на данные, которых нет в фактах (например «предлагай абонемент», а условий абонемента в фактах нет), заполни needs_details — один короткий вопрос владельцу об этих данных — и всё равно дай rule.
Если это вопрос к ассистенту или что-то другое — answer: короткий ответ владельцу по существу, на его языке; ничего не сохраняй.

Верни строго JSON без пояснений:
{"kind":"add_rule|edit_rule|remove_rule|list_rules|undo|fact|question|other","number":null,"rule":null,"fact":null,"fact_topic":null,"conflict":null,"needs_details":null,"answer":null}
conflict, если есть: {"reason":"...","alternative":"..."}.`;

/**
 * Z11, several addresses: a «Адрес и часы» fact that names a place (street words in ru/he/en, or «адрес»). Two or more
 * such facts and no answer yet → the cabinet asks how the places work. A heuristic: the owner can also say it in a fact.
 */
export const ADDRESS_FACT = /(\bул\.|улиц|проспект|пр-т|переул|шоссе|бульвар|адрес|רחוב|רח'|שדרות|כתובת|\bstreet\b|\bst\.|\bave\b|avenue|\broad\b|\brd\.|address)/i;
/** The title of the knowledge source of the answer (so the question is not asked again). */
export const ADDRESS_MODE_SOURCE_TITLE = 'Несколько адресов';
