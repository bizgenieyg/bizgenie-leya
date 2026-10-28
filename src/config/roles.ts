/**
 * Z12 (as chef-bot `services/intentRouter.js`): the reply role of a dialog. Support keywords decide at once; otherwise
 * a short classifier over the last messages; SALES by default. The role sticks to the dialog until a request is made.
 */
export type ReplyRole = 'SALES' | 'SUPPORT';
export const ROLE_HISTORY_MESSAGES = 6;

/** The client writes about something that already exists: an order, a booking, a problem with it. */
export const SUPPORT_KEYWORDS: RegExp[] = [
  // ru
  /мо[йеия]\s+(заказ|запис)/i, /где\s+(мой\s+)?заказ/i, /не\s+(пришл|пришё|привезл|приехал|получил)/i, /опаздыва/i, /проблем/i,
  /жалоб/i, /отмен(ить|а|яю)/i, /перенест|перенос/i, /изменить\s+(заказ|запис)/i, /испортил/i, /вернуть\s+деньги/i, /возврат/i,
  /не\s+работает/i, /сломал/i,
  // he
  /ההזמנה\s+שלי/, /התור\s+שלי/, /לא\s+(הגיע|קיבלתי)/, /לבטל|ביטול/, /לדחות|להזיז/, /תלונה/, /החזר\s+כספי|החזר/, /בעיה/, /לא\s+עובד/,
  // en
  /\bmy\s+(order|booking|appointment)\b/i, /\bwhere\s+is\s+my\b/i, /\b(didn'?t|did\s+not|never)\s+(arrive|come|get|receive)/i, /\bcancel/i,
  /\breschedul/i, /\bcomplain/i, /\brefund/i, /\bproblem\b/i, /\bnot\s+working\b/i, /\bbroken\b/i,
];

/** Section headings of an instruction: a line «### Продажа» / «### Поддержка» (he/en too); «### Общее» returns to the
 *  common part. Without role headings the whole instruction is used. */
export const ROLE_HEADINGS: Record<ReplyRole | 'COMMON', RegExp> = {
  SALES: /^#{1,3}\s*(продажа|מכירה|sales)\s*$/i,
  SUPPORT: /^#{1,3}\s*(поддержка|תמיכה|support)\s*$/i,
  COMMON: /^#{1,3}\s*(общее|כללי|common)\s*$/i,
};

/** The client is leaving (as chef-bot FAREWELL_PATTERNS): an owner answer after this is not forwarded. */
export const FAREWELL_PATTERNS: RegExp[] = [
  // ru
  /закаж(у|ем).{0,20}(в другом месте|у других|где-то)/i, /перед[уе]мал/i, /не буду (заказывать|записываться)/i, /не нужно,?\s*спасибо/i,
  /^нет,?\s*спасибо/i, /в друг(ой|ое) раз/i, /не актуально/i, /всё,?\s*спасибо|все,?\s*спасибо/i, /расхотел/i, /уже (заказал|записал|нашл|нашёл)/i,
  // he
  /לא\s+צריך,?\s*תודה/, /^לא,?\s*תודה/, /התחרטתי/, /כבר\s+(הזמנתי|מצאתי)/, /פעם\s+אחרת/, /לא\s+רלוונטי/,
  // en
  /\bno,?\s*thanks?\b/i, /\bchanged\s+my\s+mind\b/i, /\bnot\s+interested\b/i, /\balready\s+(ordered|booked|found)\b/i, /\bnever\s*mind\b/i, /\bmaybe\s+another\s+time\b/i,
];
export const clientIsLeaving = (text: string) => FAREWELL_PATTERNS.some(re => re.test(text.trim()));
