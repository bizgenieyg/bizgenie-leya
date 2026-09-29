/** Dictionaries behind the "owner request only with the client's consent" rule (task Q). Edited here, no migration. */

/** Words that are never a first name when they come from a WhatsApp display name. */
export const NAME_STOP_WORDS: readonly string[] = [
  'мама', 'папа', 'мамуля', 'любимый', 'любимая', 'дорогой', 'работа', 'офис', 'магазин', 'салон', 'доставка', 'такси', 'клиент', 'босс',
  'אמא', 'אבא', "אמאל'ה", 'עבודה', 'משרד',
  'mom', 'mum', 'dad', 'love', 'babe', 'work', 'office', 'shop', 'admin', 'boss',
];

/**
 * Direct requests for something only the owner can do. Stems match at a word start; an explicit
 * negation earlier in the same clause ("не надо звонить") cancels the match.
 */
export const REQUEST_ACTION_PATTERNS: readonly RegExp[] = [
  /(?<![\p{L}])(?:запиш|записат|позвон|звонит|звоните|перезвон|свяж|связат|встреч|демо|приед|приезж|приех|закаж|заказат|созвон|подключит)/iu,
  /(?<![\p{L}])(?:תקבע|תתקשר|לקבוע|פגישה|דמו|להזמין|רוצה להירשם|תחזרו|תחזור אלי)/iu,
  /\b(?:book|call me|schedule|meeting|demo|order|sign up|sign me up)\b/iu,
];
export const NEGATION_PATTERN = /(?<![\p{L}])(?:не|нет|ни|не надо|не нужно|не хочу|не стоит|לא|אין|no|not|don't|dont|do not|never)(?![\p{L}])/iu;

/** Short answers that accept the assistant's offer to pass the request to the owner. */
export const AGREEMENT_WORDS: readonly string[] = [
  'да хочу', 'хочу', 'хотим', 'да', 'давайте', 'давай', 'интересно', 'ок', 'окей', 'хорошо', 'можно', 'конечно', 'го', 'ага', 'угу', 'передайте', 'передай', 'пожалуйста', '👍', '👌',
  'כן', 'יאללה', 'בטח', 'סבבה', 'אוקיי', 'אוקי', 'בסדר', 'תעביר', 'תעבירי',
  'yes', 'yeah', 'yep', 'ok', 'okay', 'sure', "let's", 'lets', 'please', 'go ahead',
];
/** Answers that decline the offer; the offer is then not repeated unless the client returns to it. */
export const DECLINE_WORDS: readonly string[] = [
  'нет', 'не надо', 'не нужно', 'не сейчас', 'не стоит', 'позже', 'потом', 'подумаю', 'я подумаю', 'пока нет', 'не хочу',
  'לא', 'לא צריך', 'לא עכשיו', 'אחר כך', 'אחשוב', 'לא תודה',
  'no', 'nope', 'not now', 'later', "i'll think", 'no thanks', 'not really',
];

/** A reply that offers a demo, a booking or passing to the owner (a call to action). */
export const CALL_TO_ACTION_PATTERN = /(?<![\p{L}])(?:демо|запис|созвон|встреч|передать|передам|покажу|приглаша|דמו|לקבוע|פגישה|להעביר|אעביר|demo|book|schedule|meeting|pass (?:it|this|your)|call)/iu;

/** A bot question that offers a meeting, demo, call, booking or passing to the owner (task X). */
export const OFFER_QUESTION_PATTERN = /(?<![\p{L}])(?:покаж|встреч|демо|созвон|свяж|связать|переда|рассчита|запис|להראות|אראה|פגישה|דמו|לקבוע|לתאם|להעביר|לחשב|show|meet|demo|call|book|schedule|pass|calculate)/iu;
/** A reply that says the request is already passed or someone will contact (only true when code created it). */
export const CLAIMED_PASSED_PATTERN = /(?<![\p{L}])(?:свяжется|свяжутся|передал|передала|передано|передам|получит[^.!?]{0,20}(?:заявк|просьб|запрос|сообщени)|ייצור|יחזור|העברתי|הועבר|will (?:contact|call|get in touch)|passed (?:it|this|your)|forwarded)/iu;
/** The client showed interest by asking about price, terms or how to start (task X: an offer may follow). */
export const INTEREST_PATTERN = /(?<![\p{L}])(?:цен|стоит|стоимост|сколько|срок|как начать|как подключ|подключ|когда можно|попробова|пробн|כמה עולה|מחיר|מתי|איך מתחילים|לנסות|price|cost|how much|how long|how to start|get started|trial)/iu;
