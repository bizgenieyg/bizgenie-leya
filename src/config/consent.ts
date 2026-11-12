/** Dictionaries behind the "owner request only with the client's consent" rule (task Q). Edited here, no migration. */

/** Words that are never a first name when they come from a WhatsApp display name. */
export const NAME_STOP_WORDS: readonly string[] = [
  'мама', 'папа', 'мамуля', 'любимый', 'любимая', 'дорогой', 'работа', 'офис', 'магазин', 'салон', 'доставка', 'такси', 'клиент', 'босс',
  'אמא', 'אבא', "אמאל'ה", 'עבודה', 'משרד',
  'mom', 'mum', 'dad', 'love', 'babe', 'work', 'office', 'shop', 'admin', 'boss',
];

/** Z17: words of a brand or a business after a first word («Maxident Clinic») — the profile is not a person's name. */
export const NAME_BRAND_WORDS: readonly string[] = [
  'clinic', 'studio', 'salon', 'beauty', 'nails', 'spa', 'shop', 'store', 'group', 'center', 'centre', 'service', 'services', 'team', 'official', 'company', 'ltd', 'inc',
  'клиника', 'студия', 'салон', 'центр', 'сервис', 'магазин', 'школа', 'бьюти', 'ооо', 'ип',
  'קליניקה', 'סטודיו', 'מספרה', 'מרכז', 'חנות', 'שירותים', 'בע"מ',
];

/** Z17 review: common first names — such a first word stays a name before a brand word («Anna Studio», «Анна Студия маникюра»). */
export const COMMON_FIRST_NAMES: ReadonlySet<string> = new Set([
  'анна', 'александр', 'александра', 'алексей', 'андрей', 'анастасия', 'антон', 'аня', 'артём', 'артем', 'борис', 'вадим',
  'валентина', 'валерия', 'василий', 'вера', 'виктор', 'виктория', 'владимир', 'владислав', 'галина', 'даниил', 'данил', 'денис',
  'диана', 'дмитрий', 'дарья', 'ева', 'евгений', 'евгения', 'екатерина', 'елена', 'жанна', 'игорь', 'илья', 'инна',
  'ирина', 'катя', 'кирилл', 'константин', 'ксения', 'лариса', 'леонид', 'лилия', 'любовь', 'людмила', 'маргарита', 'марина',
  'мария', 'михаил', 'надежда', 'наталья', 'наталия', 'никита', 'николай', 'нина', 'оксана', 'олег', 'ольга', 'павел',
  'полина', 'роман', 'светлана', 'сергей', 'софия', 'софья', 'станислав', 'степан', 'таисия', 'тамара', 'татьяна', 'юлия',
  'юрий', 'яна', 'ярослав', 'саша', 'маша', 'даша', 'женя', 'лена', 'оля', 'таня', 'юля', 'ира',
  'света', 'anna', 'alex', 'alexander', 'alexandra', 'alexey', 'andrew', 'andrey', 'anastasia', 'anton', 'ben', 'boris',
  'daniel', 'daria', 'david', 'diana', 'dima', 'dmitry', 'elena', 'emma', 'eva', 'eugene', 'igor', 'ilya',
  'irina', 'julia', 'kate', 'katya', 'kirill', 'ksenia', 'lena', 'leo', 'liza', 'maria', 'marina', 'mark',
  'max', 'maxim', 'michael', 'mike', 'nadia', 'natalia', 'natasha', 'nick', 'nikita', 'nina', 'olga', 'oleg',
  'pavel', 'polina', 'roman', 'sarah', 'sasha', 'sergey', 'sofia', 'tanya', 'tatiana', 'victor', 'victoria', 'vlad',
  'yana', 'yulia', 'yuri', 'משה', 'דוד', 'יוסי', 'יוסף', 'אבי', 'דני', 'רון', 'נועה', 'נועם',
  'מיכל', 'שרה', 'רחל', 'לאה', 'רונית', 'אורית', 'יעל', 'תמר', 'שירה', 'אליעזר', 'אברהם', 'יצחק',
  'יעקב', 'חנה', 'מאיה', 'דנה', 'עדי', 'איתי', 'אלון',
]);

/** Z17 (as chef-bot): a Latin first name in a Russian reply — transliterated («Diana» → «Диана»). Longest first. */
export const LATIN_TO_CYRILLIC: ReadonlyArray<readonly [string, string]> = [
  ['shch', 'щ'], ['sch', 'щ'], ['zh', 'ж'], ['kh', 'х'], ['ch', 'ч'], ['sh', 'ш'], ['ts', 'ц'], ['ya', 'я'], ['yu', 'ю'], ['yo', 'ё'], ['ye', 'е'], ['ia$', 'ия'], ['iy$', 'ий'], ['y$', 'й'],
  ['a', 'а'], ['b', 'б'], ['c', 'к'], ['d', 'д'], ['e', 'е'], ['f', 'ф'], ['g', 'г'], ['h', 'х'], ['i', 'и'], ['j', 'дж'], ['k', 'к'], ['l', 'л'], ['m', 'м'],
  ['n', 'н'], ['o', 'о'], ['p', 'п'], ['q', 'к'], ['r', 'р'], ['s', 'с'], ['t', 'т'], ['u', 'у'], ['v', 'в'], ['w', 'в'], ['x', 'кс'], ['y', 'и'], ['z', 'з'],
];

/**
 * Direct requests for something only the owner can do. Stems match at a word start; an explicit
 * negation earlier in the same clause ("не надо звонить") cancels the match.
 */
export const REQUEST_ACTION_PATTERNS: readonly RegExp[] = [
  /(?<![\p{L}])(?:запиш|записат|позвон|звонит|звоните|перезвон|свяж|связат|встреч|демо|приед|приезж|приех|закаж|заказат|созвон|подключит|отмен|перенес|перенест|передвин)/iu,
  /(?<![\p{L}])(?:תקבע|תתקשר|לקבוע|פגישה|דמו|להזמין|רוצה להירשם|תחזרו|תחזור אלי|לבטל|ביטול|לדחות|להזיז|לשנות את התור)/iu,
  /\b(?:book|call me|schedule|reschedule|cancel|meeting|demo|order|sign up|sign me up)\b/iu,
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
/**
 * Z11 (eval M11): a reply that says the booking is already made or the time confirmed — only the owner does that
 * («среду после обеда записала»). Questions («Записать вас на среду?») and the client's own words do not match.
 */
export const CLAIMED_BOOKED_PATTERN = /(?<![\p{L}])(?:записала|записал(?!\p{L})|вы записаны|записаны на|забронировала|забронировал(?!\p{L})|подтверждаю (?:запись|время)|подтвердила (?:запись|время)|רשמתי|קבעתי לך|קבעתי לכם|התור נקבע|booked you|you(?:'re| are) booked|i(?:'ve| have) booked|confirmed your (?:booking|appointment)|your appointment is (?:set|confirmed))/iu;
/** The client showed interest by asking about price, terms or how to start (task X: an offer may follow). */
export const INTEREST_PATTERN = /(?<![\p{L}])(?:цен|стоит|стоимост|сколько|срок|как начать|как подключ|подключ|когда можно|попробова|пробн|כמה עולה|מחיר|מתי|איך מתחילים|לנסות|price|cost|how much|how long|how to start|get started|trial)/iu;
