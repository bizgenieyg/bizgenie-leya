/** Provider-independent optional knowledge-grounded reply generation. */
export interface AIReplyInput {
  systemPrompt: string;
  userMessage: string;
}

export interface AIUsage { model?: string; input_tokens?: number; output_tokens?: number; total_tokens?: number; thinking_tokens?: number; cached_input_tokens?: number; }
export class AIProviderError extends Error {
  readonly usage: AIUsage | undefined;
  constructor(message:string,usage?:AIUsage){super(message);this.usage=usage;}
}
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
