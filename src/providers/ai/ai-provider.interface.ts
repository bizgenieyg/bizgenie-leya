/**
 * Phase 1 placeholder only.
 *
 * The Knowledge Module answers by exact FAQ match; unknown questions escalate to
 * the owner. No generative AI runs in Phase 1. This interface exists so later
 * phases can plug in a provider without reshaping call sites.
 */
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

/** Default Phase 1 provider: refuses to generate, forcing exact-match/escalation. */
export class UnavailableAIProvider implements AIProvider {
  generateReply(): Promise<AIReplyResult> {
    return Promise.reject(new Error("AIProvider is not available in Phase 1"));
  }
}
