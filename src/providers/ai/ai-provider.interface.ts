/** Provider-independent optional knowledge-grounded reply generation. */
export interface AIReplyInput {
  systemPrompt: string;
  userMessage: string;
  /** Inline images (price-list photos) for vision-capable task models; base64 without the data: prefix. */
  images?: Array<{ mimeType: string; data: string }>;
  /** Task Z: the conversation as chat turns before `userMessage` (the latest client message). */
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  /** Per-call output cap and thinking (Gemini: see GeminiOptions); overrides the provider's own options. */
  generation?: { maxOutputTokens?: number; retryMaxOutputTokens?: number; thinkingLevels?: Record<string, string>; timeoutMs?: number; attemptTimeoutMs?: number; retryDelayMs?: number };
}

export interface AIUsage { model?: string; input_tokens?: number; output_tokens?: number; total_tokens?: number; thinking_tokens?: number; cached_input_tokens?: number; cache_write_tokens?: number; finish_reason?: string;
  /** Z4: every billed attempt of this call when there was more than one (the top-level counts are their sum). */
  attempts?: AIUsage[]; }
/** Why a model call failed: safe operational codes only (HTTP code, provider status), never prompt/key text. */
export interface AIFailure { reason:string; httpStatus?:number; providerStatus?:string; providerMessage?:string }
export class AIProviderError extends Error {
  readonly usage: AIUsage | undefined;
  readonly failure: AIFailure;
  constructor(message:string,usage?:AIUsage,failure:AIFailure={reason:'unavailable'}){super(message);this.usage=usage;this.failure=failure;}
}
/** Marks a provider that cannot answer at all (no API key); kept by metering wrappers. */
export const MODEL_UNAVAILABLE=Symbol.for('leya.model-unavailable');
export const modelUnavailable=(ai:unknown):boolean=>!ai||(ai as Record<symbol,unknown>)[MODEL_UNAVAILABLE]===true;
/** Z4: one usage for several billed attempts — counts summed, each attempt kept for per-attempt pricing. */
export function combineUsage(list: Array<AIUsage | undefined>): AIUsage | undefined {
  const billed = list.flatMap(u => u ? (u.attempts ?? [u]) : []);
  if (billed.length <= 1) return billed[0];
  const sum = (k: 'input_tokens' | 'output_tokens' | 'total_tokens' | 'thinking_tokens' | 'cached_input_tokens' | 'cache_write_tokens') => billed.reduce((n, u) => n + (u[k] ?? 0), 0);
  const last = billed.at(-1)!;
  return { ...(last.model ? { model: last.model } : {}), input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'), total_tokens: sum('total_tokens'), thinking_tokens: sum('thinking_tokens'),
    cached_input_tokens: sum('cached_input_tokens'), cache_write_tokens: sum('cache_write_tokens'), ...(last.finish_reason ? { finish_reason: last.finish_reason } : {}), attempts: billed };
}
export const failureReason=(error:unknown):string=>error instanceof AIProviderError?error.failure.reason:'unavailable';
export interface AIReplyResult {
  usage?: AIUsage;
  text: string;
}

export interface AIProvider {
  generateReply(input: AIReplyInput): Promise<AIReplyResult>;
}

/** Explicitly disabled provider; callers retain escalation behavior. */
export class UnavailableAIProvider implements AIProvider {
  generateReply(): Promise<AIReplyResult> {
    return Promise.reject(new Error("AIProvider is disabled"));
  }
}
