import { AGREEMENT_WORDS, CALL_TO_ACTION_PATTERN, COMMON_FIRST_NAMES, DECLINE_WORDS, LATIN_TO_CYRILLIC, NAME_BRAND_WORDS, NAME_STOP_WORDS, NEGATION_PATTERN, REQUEST_ACTION_PATTERNS } from '../config/consent.js';

const normalize = (text: string) => text.toLowerCase().replace(/[ё]/g, 'е').replace(/[^\p{L}\p{N}'👍👌\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
const WORD = /^[\p{L}][\p{L}'’-]*$/u;
const upper = (w: string) => w === w.toUpperCase() && w !== w.toLowerCase();

/**
 * First name suitable for addressing the client, or null. Z17: the profile may go on after the name — a surname, a
 * description, emoji («Александр Коско тренинги, курсы…», «Diana✨»): the first word is taken when it looks like a name —
 * letters (hyphen/apostrophe allowed), 2–20 characters, not a stop word («Мама», «Работа»), not the business name, not
 * SHOUTED (all caps, longer than 3 letters) — and, unless it is a common first name, the next word is not a brand word
 * («Maxident Clinic» → null, «Anna Studio» → Anna). Digits, «@» and
 * dots in the first word disqualify it. In a Russian reply a Latin name is transliterated («Yana» → «Яна»).
 */
export function usableFirstName(name: string | null | undefined, businessName?: string | null, language?: string | null): string | null {
  const words = (name ?? '').trim().split(/[\s,;|/]+/).filter(Boolean);
  const raw = words[0] ?? '';
  if (/[\d@.]/.test(raw)) return null;
  const first = raw.replace(/^[^\p{L}]+|[^\p{L}'’-]+$/gu, '').replace(/[-'’]+$/, '');
  if (!WORD.test(first) || first.length < 2 || first.length > 20 || (upper(first) && first.length > 3)) return null;
  const business = new Set(normalize(businessName ?? '').split(' ').filter(Boolean));
  const word = (w: string) => w.toLowerCase().replace(/[^\p{L}"]+/gu, '');
  if (NAME_STOP_WORDS.includes(first.toLowerCase()) || business.has(normalize(first))) return null;
  const next = word(words[1] ?? '');
  // Z17 review: a known first name stays before a brand or description word («Anna Studio»); an unknown word followed
  // by one is taken for a brand («Maxident Clinic»).
  if (next && !COMMON_FIRST_NAMES.has(first.toLowerCase().replace(/ё/g, 'е')) && (NAME_BRAND_WORDS.includes(next) || NAME_STOP_WORDS.includes(next) || business.has(normalize(next)))) return null;
  const value = first.charAt(0).toLocaleUpperCase() + first.slice(1);
  return language === 'ru' && /^[a-z'’-]+$/i.test(value) ? transliterate(value) : value;
}

function transliterate(name: string): string {
  let rest = name.toLowerCase(), out = '';
  while (rest) {
    const [latin, cyrillic] = LATIN_TO_CYRILLIC.find(([l]) => l.endsWith('$') ? rest === l.slice(0, -1) : rest.startsWith(l)) ?? [rest[0]!, rest[0]!];
    out += cyrillic; rest = rest.slice(latin.replace('$', '').length);
  }
  return out.charAt(0).toLocaleUpperCase() + out.slice(1);
}

const clauses = (text: string) => text.split(/[.!?;,\n]+|(?<![\p{L}])(?:но|а|but|אבל)(?![\p{L}])/iu).map(c => c.trim()).filter(Boolean);
/**
 * A name the client gave about themselves: kept as said (no stop list — they chose it), only 1–40
 * characters of letters, spaces, hyphens and apostrophes; no digits, links or "@". First letter upper case.
 */
export function preferredName(name: string | null | undefined): string | null {
  const value = (name ?? '').trim().replace(/\s+/g, ' ');
  if (!value || value.length > 40 || /[\d@/:.]|www/i.test(value) || !/^[\p{L}][\p{L}'’ -]*$/u.test(value)) return null;
  return value.charAt(0).toLocaleUpperCase() + value.slice(1);
}

/** "хочу демо", "перезвоните мне" — yes; "не надо звонить", "что такое демо, не хочу" — no. */
export function isDirectRequest(text: string): boolean {
  return clauses(text).some(clause => REQUEST_ACTION_PATTERNS.some(pattern => {
    const match = pattern.exec(clause);
    return !!match && !NEGATION_PATTERN.test(clause.slice(0, match.index));
  }));
}

const startsWithPhrase = (text: string, phrases: readonly string[]) => {
  const t = normalize(text);
  return phrases.map(p => normalize(p)).filter(Boolean).sort((a, b) => b.length - a.length).find(p => t === p || t.startsWith(`${p} `)) ?? null;
};
/** Short decline of an offer ("нет", "не сейчас", "לא תודה"). */
export function isDecline(text: string): boolean {
  const t = normalize(text);
  return t.split(' ').length <= 6 && !!startsWithPhrase(text, DECLINE_WORDS);
}
/**
 * Short agreement ("да", "давайте", "👍", "да, Аня"): starts with an agreement word, no negation or
 * decline, at most 6 words. Returns the remainder, which may carry the client's name.
 */
export function agreement(text: string): { rest: string } | null {
  const t = normalize(text);
  if (!t || t.split(' ').length > 6 || isDecline(text)) return null;
  const phrase = startsWithPhrase(text, AGREEMENT_WORDS);
  if (!phrase) return null;
  const rest = t.slice(phrase.length).trim();
  if (NEGATION_PATTERN.test(rest)) return null;
  return { rest: rest.replace(/^(?:меня зовут|я|зовут|my name is|i am|i'm|אני|קוראים לי)\s+/iu, '') };
}

/** The reply offers a demo, a booking or passing the request to the owner. */
export const hasCallToAction = (reply: string) => CALL_TO_ACTION_PATTERN.test(reply);
