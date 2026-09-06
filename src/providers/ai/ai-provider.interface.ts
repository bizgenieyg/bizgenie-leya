/** Provider-independent optional knowledge-grounded reply generation. */
export interface AIReplyInput {
  systemPrompt: string;
  userMessage: string;
}

export interface AIReplyResult {
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
