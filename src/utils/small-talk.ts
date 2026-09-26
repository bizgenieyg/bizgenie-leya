import { ACKNOWLEDGEMENT_PHRASES, BARE_ACKNOWLEDGEMENT_MAX_CHARS, BARE_GREETING_MAX_CHARS, GREETING_PHRASES } from '../config/small-talk.js';

const words = (text: string) => text.toLowerCase().normalize('NFC')
  .replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}‍️]/gu, ' ')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
const phrases = (list: string[]) => list.map(p => words(p)).sort((a, b) => b.length - a.length);
const GREETINGS = phrases(GREETING_PHRASES), ACKS = phrases(ACKNOWLEDGEMENT_PHRASES);
/** Tokens that only address the assistant or soften the greeting ("всем", "ребята", "there", "all"). */
const FILLERS = new Set(['всем', 'все', 'ребята', 'друзья', 'there', 'all', 'everyone', 'לכולם', 'again', 'снова', 'ещё', 'еще', 'раз', 'очень', 'вам']);

/** Consume leading phrases from `list`; returns how many tokens were consumed. */
function consume(tokens: string[], list: string[][]): number {
  let i = 0, matched = false;
  for (;;) {
    const hit = list.find(p => p.every((w, k) => tokens[i + k] === w));
    if (hit) { i += hit.length; matched = true; continue; }
    if (matched && i < tokens.length && FILLERS.has(tokens[i]!)) { i++; continue; }
    return matched ? i : 0;
  }
}

/** Only greeting words, signs or emoji, at most BARE_GREETING_MAX_CHARS. */
export function isBareGreeting(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > BARE_GREETING_MAX_CHARS) return false;
  const tokens = words(trimmed);
  return tokens.length > 0 && consume(tokens, GREETINGS) === tokens.length;
}

/** Thanks / ok / emoji only, no question. An emoji-only message counts as an acknowledgement. */
export function isAcknowledgement(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > BARE_ACKNOWLEDGEMENT_MAX_CHARS || trimmed.includes('?')) return false;
  const tokens = words(trimmed);
  if (!tokens.length) return /\p{Extended_Pictographic}/u.test(trimmed);
  return consume(tokens, ACKS) === tokens.length;
}

/**
 * "Привет, сколько стоит…" → "сколько стоит…": drops a leading greeting so the rest is handled
 * normally. Returns the original text when it does not start with a greeting or nothing would remain.
 */
export function withoutLeadingGreeting(text: string): string {
  const original = text.trim();
  const tokens = words(original);
  const used = consume(tokens, GREETINGS);
  if (!used || used >= tokens.length) return original;
  // Walk the original string past the first `used` word tokens and trailing punctuation/emoji.
  let seen = 0, index = 0;
  const pattern = /[\p{L}\p{N}]+/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(original)) && seen < used) { seen++; index = match.index + match[0].length; }
  const rest = original.slice(index).replace(/^[^\p{L}\p{N}]+/u, '').trim();
  return rest || original;
}
