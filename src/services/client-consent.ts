import { AGREEMENT_WORDS, CALL_TO_ACTION_PATTERN, DECLINE_WORDS, NAME_STOP_WORDS, NEGATION_PATTERN, REQUEST_ACTION_PATTERNS } from '../config/consent.js';

const normalize = (text: string) => text.toLowerCase().replace(/[ё]/g, 'е').replace(/[^\p{L}\p{N}'👍👌\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
const WORD = /^[\p{L}][\p{L}'’-]*$/u;
const upper = (w: string) => w === w.toUpperCase() && w !== w.toLowerCase();

/**
 * First name suitable for addressing the client, or null: 1–2 words of letters (hyphen/apostrophe allowed),
 * each 2–20 characters (a surname may be an initial: "Anna K"), not a stop word ("Мама", "Работа", "Love"), not the business name, not SHOUTED
 * (all caps, longer than 3 letters). Digits, emoji, "@" and dots disqualify the whole name.
 */
export function usableFirstName(name: string | null | undefined, businessName?: string | null): string | null {
  const raw = (name ?? '').trim();
  if (!raw || /[\d@.]/.test(raw) || /\p{Extended_Pictographic}/u.test(raw)) return null;
  const words = raw.split(/\s+/);
  if (words.length > 2 || words.some((w, i) => !WORD.test(w) || w.length < (i ? 1 : 2) || w.length > 20)) return null;
  const business = new Set(normalize(businessName ?? '').split(' ').filter(Boolean));
  if (words.some(w => NAME_STOP_WORDS.includes(w.toLowerCase()) || business.has(normalize(w)) || (upper(w) && w.length > 3))) return null;
  const first = words[0]!;
  return first.charAt(0).toLocaleUpperCase() + first.slice(1);
}

const clauses = (text: string) => text.split(/[.!?;,\n]+|(?<![\p{L}])(?:но|а|but|אבל)(?![\p{L}])/iu).map(c => c.trim()).filter(Boolean);
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
