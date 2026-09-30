/**
 * Task Z: the answer is plain text with service labels at the end. Code parses the labels, strips them from
 * the client text and runs exactly two checks: the request (consent and required fields) and the numbers.
 */
export const LABEL_NAMES = ['OFFER', 'REQUEST', 'ASK_OWNER', 'HUMAN', 'DATA_REQUEST', 'DEMO_START', 'DEMO_END'] as const;
export type LabelName = (typeof LABEL_NAMES)[number];
export interface Label { name: LabelName; value: string | null }
export interface ParsedReply { text: string; labels: Label[]; unknown: string[] }

const LABEL = /\[\[\s*([A-Za-z_]+)\s*(?::\s*([^\]]*?))?\s*\]\]/g;
/** Labels out, client text in. Unknown label names are reported (never executed). */
export function parseLabels(raw: string): ParsedReply {
  const labels: Label[] = [], unknown: string[] = [];
  const text = raw.replace(LABEL, (_all, name: string, value: string | undefined) => {
    const upper = name.toUpperCase();
    if ((LABEL_NAMES as readonly string[]).includes(upper)) labels.push({ name: upper as LabelName, value: value?.trim() || null });
    else unknown.push(upper);
    return '';
  }).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, labels, unknown };
}
export const hasLabel = (parsed: ParsedReply, name: LabelName) => parsed.labels.some(l => l.name === name);
export const labelValue = (parsed: ParsedReply, name: LabelName) => parsed.labels.find(l => l.name === name)?.value ?? null;

/** Leftovers that must never reach a client: brackets, placeholders, JS nulls. */
export const unsafeClientText = (text: string) => !text.trim() || /\[\[|\]\]|[<>{}]|\bundefined\b|\bnull\b/.test(text);

/** "consultation | city=Ашдод; when=среда" → {type, fields}. */
export function parseRequestValue(value: string | null): { type: string; fields: Record<string, string> } | null {
  if (!value) return null;
  const [typePart, ...rest] = value.split('|');
  const type = (typePart ?? '').trim().toLowerCase();
  if (!/^[a-z_]{1,30}$/.test(type)) return null;
  const fields: Record<string, string> = {};
  for (const pair of rest.join('|').split(';')) {
    const at = pair.indexOf('=');
    if (at < 0) continue;
    const key = pair.slice(0, at).trim().toLowerCase(), val = pair.slice(at + 1).trim();
    if (/^[a-z_]{1,30}$/.test(key) && val && !/^[….]+$/.test(val)) fields[key] = val.slice(0, 200);
  }
  return { type, fields };
}
/** Required fields of this request type that are empty. */
export const missingFields = (request: { type: string; fields: Record<string, string> }, required: Record<string, string[]>) =>
  (required[request.type] ?? []).filter(field => !request.fields[field]);

// ---- Numbers ---------------------------------------------------------------------------------------------
const UNIT = String.raw`(?:₪|шекел\p{L}*|\$|%|мин\p{L}*|час\p{L}*|дн\p{L}*|день|мес\p{L}*|мл|кг|л(?![\p{L}])|ש"ח|שקל\p{L}*|דק\p{L}*|שע\p{L}*|ימי\p{L}*|יום|חודש\p{L}*|min\p{L}*|hour\p{L}*|day\p{L}*|month\p{L}*|nis|ils|shekel\p{L}*)`;
const NUM = String.raw`\d{1,3}(?:[  .]\d{3})+|\d+(?:[.,]\d+)?`;
const AFTER = new RegExp(String.raw`(${NUM})(?:\s*[-–—]\s*(${NUM}))?\s*${UNIT}`, 'giu');
const BEFORE = new RegExp(String.raw`(?:₪|\$)\s*(${NUM})(?:\s*[-–—]\s*(${NUM}))?`, 'giu');
const CLOCK = /\b([01]?\d|2[0-3]):[0-5]\d\b/g;
/** "1 000" = "1.000" = "1000"; "1,5" = "1.5". */
export const normalizeNumber = (n: string) => /^\d{1,3}(?:[  .]\d{3})+$/.test(n) ? n.replace(/[  .]/g, '') : n.replace(',', '.');

/** Numbers of a reply that must be backed by the tenant's facts/instruction: next to a unit, and HH:MM. */
export function checkedNumbers(text: string): string[] {
  const out = new Set<string>();
  for (const re of [AFTER, BEFORE]) for (const m of text.matchAll(re)) { out.add(normalizeNumber(m[1]!)); if (m[2]) out.add(normalizeNumber(m[2])); }
  for (const m of text.matchAll(CLOCK)) out.add(m[0]!.padStart(5, '0'));
  return [...out];
}
/** Every number in the corpus (facts, instruction, demo text), normalised the same way. */
export function corpusNumbers(corpus: string): Set<string> {
  const out = new Set<string>();
  for (const m of corpus.matchAll(new RegExp(NUM, 'g'))) out.add(normalizeNumber(m[0]!));
  for (const m of corpus.matchAll(CLOCK)) out.add(m[0]!.padStart(5, '0'));
  return out;
}
/** Numbers of the reply absent from the corpus (the check fails when not empty). */
export const unbackedNumbers = (text: string, corpus: string) => { const known = corpusNumbers(corpus); return checkedNumbers(text).filter(n => !known.has(n)); };
