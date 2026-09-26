/** Provider-independent optional knowledge-grounded reply generation. */
export interface AIReplyInput {
  systemPrompt: string;
  userMessage: string;
}

export interface AIUsage { model?: string; input_tokens?: number; output_tokens?: number; total_tokens?: number; thinking_tokens?: number; cached_input_tokens?: number; }
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
