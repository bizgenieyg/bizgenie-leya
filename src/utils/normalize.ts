/**
 * Shared text normalization for exact FAQ matching.
 *
 * Trim, case-fold, drop light punctuation, collapse internal whitespace.
 * Deliberately conservative: it must never turn two genuinely different
 * questions into the same string.
 */
const PUNCTUATION = /[.,!?;:¡¿"'`(){}\[\]<>]/g;

export function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(PUNCTUATION, " ")
    .replace(/\s+/g, " ")
    .trim();
}
