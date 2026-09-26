import { AIProviderError, MODEL_UNAVAILABLE, type AIProvider, type AIReplyInput, type AIReplyResult } from './ai-provider.interface.js';
import { recordModelOutcome } from '../../services/model-health.service.js';

/**
 * Used when GEMINI_API_KEY is absent: every call fails like an outage (failure_reason
 * 'missing_api_key', model health alert), so a missing key never looks like missing knowledge.
 */
export class MissingKeyProvider implements AIProvider {
  readonly [MODEL_UNAVAILABLE] = true;
  async generateReply(_input: AIReplyInput): Promise<AIReplyResult> {
    const failure = { reason: 'missing_api_key' };
    recordModelOutcome(false, failure);
    throw new AIProviderError('Model API key missing', undefined, failure);
  }
}
