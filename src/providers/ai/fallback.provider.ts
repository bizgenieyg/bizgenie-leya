import { AIProviderError, MODEL_UNAVAILABLE, modelUnavailable, type AIProvider, type AIReplyInput, type AIReplyResult } from './ai-provider.interface.js';

/** Failures of the primary model that send the call to the fallback: outages, not answers (Z4). */
const OUTAGE = /^(timeout|network|unavailable|http_5\d\d)$/;
export const isOutage = (error: unknown) => error instanceof AIProviderError ? OUTAGE.test(error.failure.reason) : !(error instanceof Error && /incomplete|empty/.test(error.message));

/**
 * Task Z4 (operator setting reply_fallback_model): one attempt on the fallback model when the primary one is down
 * (timeout / unavailable / network / 5xx). Logged with the reason and both models; other failures are not retried.
 */
export function withFallback(primary: AIProvider, fallback: AIProvider, models: { primary: string; fallback: string }): AIProvider {
  return {
    ...(modelUnavailable(primary) && modelUnavailable(fallback) ? { [MODEL_UNAVAILABLE]: true } : {}),
    async generateReply(input: AIReplyInput): Promise<AIReplyResult> {
      try { return await primary.generateReply(input); }
      catch (error) {
        if (!isOutage(error)) throw error;
        console.warn('model_fallback', { model: models.primary, fallback: models.fallback, reason: error instanceof AIProviderError ? error.failure.reason : 'unavailable' });
        return fallback.generateReply(input);
      }
    },
  };
}
