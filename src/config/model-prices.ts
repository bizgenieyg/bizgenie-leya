/**
 * Task Z4: model prices, USD per 1M tokens (standard tier), checked 11.10.2026:
 * https://ai.google.dev/gemini-api/docs/pricing · https://platform.claude.com/docs/en/about-claude/pricing ·
 * https://developers.openai.com/api/docs/pricing
 * Thinking/reasoning tokens are billed as output. A tier applies from `from` (inclusive date) and while the prompt
 * of one call is at most `maxPromptTokens`; the most specific matching tier wins. A model not listed has no price
 * ("цена не задана"), never a default.
 */
export interface PriceTier { input: number; output: number; cacheRead: number | null; cacheWrite: number | null; from?: string; maxPromptTokens?: number }
export const MODEL_PRICES: Record<string, PriceTier[]> = {
  'gemini-3.8-flash': [
    { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: null },
    { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: null, from: '2027-01-01' },
  ],
  'gemini-3.5-flash-lite': [{ input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: null }],
  'claude-haiku-5-5': [
    { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
    { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, maxPromptTokens: 100_000 },
  ],
  'claude-sonnet-5-5': [{ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
  'gpt-6-luna': [
    { input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 },
    { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, maxPromptTokens: 272_000 },
  ],
  'gpt-6.1-sol': [
    { input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 },
    { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, maxPromptTokens: 272_000 },
  ],
};

/** The tier for one call; null — the model has no price. */
export function priceFor(model: string, date: Date, promptTokens: number): PriceTier | null {
  const day = date.toISOString().slice(0, 10);
  const tiers = (MODEL_PRICES[model] ?? []).filter(t => (!t.from || t.from <= day) && (t.maxPromptTokens === undefined || promptTokens <= t.maxPromptTokens));
  if (!tiers.length) return null;
  const latest = tiers.reduce((a, t) => ((t.from ?? '') > (a ?? '') ? (t.from ?? '') : a), '' as string);
  return tiers.filter(t => (t.from ?? '') === latest).sort((a, b) => (a.maxPromptTokens ?? Infinity) - (b.maxPromptTokens ?? Infinity))[0]!;
}

/** Token usage of one call, normalised by the providers: `input` includes cache reads and writes. */
export interface CallTokens { input: number; output: number; thinking: number; cacheRead: number; cacheWrite: number }
/** USD of one call; null when the model has no price. Without a cache price, cached tokens are billed as input. */
export function callCost(model: string, date: Date, t: CallTokens): number | null {
  const p = priceFor(model, date, t.input);
  if (!p) return null;
  const read = p.cacheRead === null ? 0 : t.cacheRead, write = p.cacheWrite === null ? 0 : t.cacheWrite;
  return ((t.input - read - write) * p.input + read * (p.cacheRead ?? 0) + write * (p.cacheWrite ?? 0) + (t.output + t.thinking) * p.output) / 1e6;
}
