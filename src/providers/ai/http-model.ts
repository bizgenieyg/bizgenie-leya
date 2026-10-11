import { AIProviderError, combineUsage, type AIFailure, type AIReplyInput, type AIReplyResult, type AIUsage } from './ai-provider.interface.js';
import { recordModelOutcome } from '../../services/model-health.service.js';
import { MODEL_CALL_DEFAULTS } from '../../config/behavior.js';

/** Options without undefined values, so a missing per-call value never hides a default. */
export const definedOnly = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/**
 * Task Z4: the shared request loop of the Anthropic and OpenAI providers, with the Gemini provider's behaviour:
 * overall and per-attempt timeouts, one retry on 429/5xx/network, one retry with the larger output cap after
 * 'incomplete_max_tokens' (logged, not an outage), failure codes only in logs (never prompt, text or key).
 */
export interface HttpModelOptions { maxOutputTokens?: number; retryMaxOutputTokens?: number; timeoutMs?: number; attemptTimeoutMs?: number; retryDelayMs?: number }
export interface ParsedResponse { text: string; usage: AIUsage; incomplete: string | null }
export interface HttpModelSpec {
  provider: string; model: string; url: string; headers: Record<string, string>;
  body(input: AIReplyInput, maxOutputTokens: number): unknown;
  parse(data: unknown): ParsedResponse;
  /** Provider error envelope → short status/message (keys masked). */
  error(data: unknown): { status?: string; message?: string };
}
const KEY_PATTERN = /(sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{10,})/g;
export const safeCount = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export async function generateWithRetry(spec: HttpModelSpec, input: AIReplyInput, options: HttpModelOptions): Promise<AIReplyResult> {
  const limits = { ...definedOnly(options), ...definedOnly(input.generation ?? {}) };
  const cap = limits.maxOutputTokens ?? 1024, retry = limits.retryMaxOutputTokens;
  if (!retry || retry <= cap) return request(spec, input, limits, cap, true);
  try { return await request(spec, input, limits, cap, false); }
  catch (error) {
    if (!(error instanceof AIProviderError) || error.failure.reason !== 'incomplete_max_tokens') throw error;
    console.warn('model_retry_max_tokens', { model: spec.model, from: cap, to: retry });
    // The cut first attempt is billed too: its usage travels with the result or the final error (Z4).
    try { const result = await request(spec, input, limits, retry, true); const usage = combineUsage([error.usage, result.usage]); return usage ? { ...result, usage } : result; }
    catch (second) { if (second instanceof AIProviderError) throw new AIProviderError(second.message, combineUsage([error.usage, second.usage]), second.failure); throw second; }
  }
}

async function request(spec: HttpModelSpec, input: AIReplyInput, options: HttpModelOptions, maxOutputTokens: number, final: boolean): Promise<AIReplyResult> {
  let usage: AIUsage = { model: spec.model };
  let failure: AIFailure = { reason: 'unavailable' };
  const fail = async (response: Response) => {
    failure = { reason: `http_${response.status}`, httpStatus: response.status };
    try {
      const e = spec.error(await response.json());
      if (e.status) failure.providerStatus = e.status.slice(0, 60);
      if (e.message) failure.providerMessage = e.message.replace(KEY_PATTERN, '[key]').slice(0, 200);
    } catch { /* non-JSON error body */ }
    return new Error(failure.reason);
  };
  try {
    const t = { ...MODEL_CALL_DEFAULTS, ...definedOnly(options) };
    const overall = AbortSignal.timeout(t.timeoutMs);
    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetch(spec.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...spec.headers }, redirect: 'error',
          signal: AbortSignal.any([overall, AbortSignal.timeout(t.attemptTimeoutMs)]), body: JSON.stringify(spec.body(input, maxOutputTokens)) });
      } catch {
        if (attempt || overall.aborted) { failure = { reason: overall.aborted ? 'timeout' : 'network' }; throw new Error('network'); }
        await new Promise(resolve => setTimeout(resolve, t.retryDelayMs));
        continue;
      }
      if (response.ok) break;
      if (attempt || !(response.status === 429 || response.status >= 500) || overall.aborted) throw await fail(response);
      await new Promise(resolve => setTimeout(resolve, t.retryDelayMs));
    }
    if (!response?.ok) throw response ? await fail(response) : new Error('request failed');
    const parsed = spec.parse(await response.json());
    usage = { model: spec.model, ...parsed.usage };
    if (parsed.incomplete) { failure = { reason: `incomplete_${parsed.incomplete}` }; throw new Error('incomplete'); }
    if (!parsed.text.trim()) { failure = { reason: 'empty' }; throw new Error('empty'); }
    recordModelOutcome(true);
    return { text: parsed.text.trim(), usage };
  } catch {
    if (!final && failure.reason === 'incomplete_max_tokens') throw new AIProviderError(`${spec.provider} reply incomplete`, usage, failure);
    console.error('model_call_failed', { model: spec.model, ...failure });
    recordModelOutcome(false, failure);
    throw new AIProviderError(`${spec.provider} reply unavailable`, usage, failure);
  }
}
