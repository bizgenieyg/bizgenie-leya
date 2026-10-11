import { AIProviderError, combineUsage, type AIFailure, type AIUsage } from "./ai-provider.interface.js";
import { MODEL_CALL_DEFAULTS } from "../../config/behavior.js";
import { definedOnly } from "./http-model.js";
import { recordModelOutcome } from "../../services/model-health.service.js";
import type { AIProvider, AIReplyInput, AIReplyResult } from "./ai-provider.interface.js";

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
/** One-off tasks (fact extraction, audit, classification): a stronger model, longer output and time. */
export const DEFAULT_GEMINI_TASK_MODEL = "gemini-3.8-flash";
/**
 * maxOutputTokens is one cap for thinking and text together (Gemini 3.x). thinkingLevels: model → thinkingLevel
 * ('minimal'|'low'|'medium'|'high', generationConfig.thinkingConfig); a model not listed gets no thinkingConfig
 * (its own default). retryMaxOutputTokens: one more attempt with this cap after 'incomplete_max_tokens'.
 */
export interface GeminiOptions { maxOutputTokens?: number; retryMaxOutputTokens?: number; thinkingLevels?: Record<string, string>; timeoutMs?: number; attemptTimeoutMs?: number; retryDelayMs?: number }

export class GeminiProvider implements AIProvider {
  constructor(private readonly apiKey: string, private readonly model = DEFAULT_GEMINI_MODEL, private readonly options: GeminiOptions = {}) {}

  async generateReply(input: AIReplyInput): Promise<AIReplyResult> {
    const limits = { ...definedOnly(this.options), ...definedOnly(input.generation ?? {}) };
    const cap = limits.maxOutputTokens ?? 1024, retry = limits.retryMaxOutputTokens;
    const thinkingLevel = limits.thinkingLevels?.[this.model];
    const t = { ...MODEL_CALL_DEFAULTS, ...definedOnly({ timeoutMs: limits.timeoutMs, attemptTimeoutMs: limits.attemptTimeoutMs, retryDelayMs: limits.retryDelayMs }) };
    if (!retry || retry <= cap) return this.request(input, cap, thinkingLevel, true, t);
    try { return await this.request(input, cap, thinkingLevel, false, t); }
    catch (error) {
      if (!(error instanceof AIProviderError) || error.failure.reason !== 'incomplete_max_tokens') throw error;
      console.warn('model_retry_max_tokens', { model: this.model, from: cap, to: retry });
      // The cut first attempt is billed too: its usage travels with the result or the final error (Z4).
      try { const result = await this.request(input, retry, thinkingLevel, true, t); const usage = combineUsage([error.usage, result.usage]); return usage ? { ...result, usage } : result; }
      catch (second) { if (second instanceof AIProviderError) throw new AIProviderError(second.message, combineUsage([error.usage, second.usage]), second.failure); throw second; }
    }
  }

  private async request(input: AIReplyInput, maxOutputTokens: number, thinkingLevel: string | undefined, final: boolean, t: typeof MODEL_CALL_DEFAULTS): Promise<AIReplyResult> {
    let usage: AIUsage = { model: this.model };
    let failure: AIFailure = { reason: 'unavailable' };
    const fail = async (response: Response, reason: string) => {
      // Gemini's error envelope {error:{code,status,message}} carries no prompt or key; keep it short.
      failure = { reason, httpStatus: response.status };
      try {
        const body = await response.json() as { error?: { status?: unknown; message?: unknown } };
        if (typeof body.error?.status === 'string') failure.providerStatus = body.error.status.slice(0, 60);
        if (typeof body.error?.message === 'string') failure.providerMessage = body.error.message.replace(/AIza[0-9A-Za-z_-]{10,}/g, '[key]').slice(0, 200);
      } catch { /* non-JSON error body */ }
      return new Error(reason);
    };
    try {
      const overall = AbortSignal.timeout(t.timeoutMs);
      let response: Response | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
            redirect: "error",
            signal: AbortSignal.any([overall, AbortSignal.timeout(t.attemptTimeoutMs)]),
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: input.systemPrompt }] },
              contents: [
                ...(input.history ?? []).filter(turn => turn.text.trim()).map(turn => ({ role: turn.role === 'assistant' ? 'model' : 'user', parts: [{ text: turn.text }] })),
                { role: "user", parts: [{ text: input.userMessage }, ...(input.images ?? []).map(image => ({ inlineData: { mimeType: image.mimeType, data: image.data } }))] },
              ],
              generationConfig: { maxOutputTokens, ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}) },
            }),
          });
        } catch {
          if (attempt || overall.aborted) { failure = { reason: overall.aborted ? 'timeout' : 'network' }; throw new Error('Gemini network unavailable'); }
          await new Promise(resolve => setTimeout(resolve, t.retryDelayMs));
          continue;
        }
        if (response.ok) break;
        if (attempt || !(response.status === 429 || response.status >= 500) || overall.aborted) throw await fail(response, `http_${response.status}`);
        await new Promise(resolve => setTimeout(resolve, t.retryDelayMs));
      }
      if (!response?.ok) throw response ? await fail(response, `http_${response.status}`) : new Error("Gemini request failed");
      const data = await response.json() as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number }; candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[] };
      const tokens = data.usageMetadata;
      const safe = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
      usage = { model: this.model,
        ...(safe(tokens?.promptTokenCount) ? { input_tokens: tokens!.promptTokenCount! } : {}),
        ...(safe(tokens?.candidatesTokenCount) ? { output_tokens: tokens!.candidatesTokenCount! } : {}),
        ...(safe(tokens?.totalTokenCount) ? { total_tokens: tokens!.totalTokenCount! } : {}),
        ...(safe(tokens?.thoughtsTokenCount) ? { thinking_tokens: tokens!.thoughtsTokenCount! } : {}),
        ...(safe(tokens?.cachedContentTokenCount) ? { cached_input_tokens: tokens!.cachedContentTokenCount! } : {}),
      };
      const candidate = data.candidates?.[0];
      if (candidate?.finishReason !== "STOP") { failure = { reason: `incomplete_${String(candidate?.finishReason ?? 'none').toLowerCase()}` }; throw new Error("Gemini reply incomplete"); }
      const text = candidate.content?.parts?.filter(part => !part.thought && typeof part.text === "string").map(part => part.text).join("").trim();
      if (!text) { failure = { reason: 'empty' }; throw new Error("Gemini reply empty"); }
      recordModelOutcome(true);
      return { text, usage: { ...usage, finish_reason: candidate.finishReason } };
    } catch {
      // A capped first attempt that will be retried is not an outage: neither logged as a failure nor counted.
      if (!final && failure.reason === 'incomplete_max_tokens') throw new AIProviderError("Gemini reply incomplete", usage, failure);
      // Operational codes only: never the prompt, the client's text or the key.
      console.error('model_call_failed', { model: this.model, ...failure });
      recordModelOutcome(false, failure);
      throw new AIProviderError("Gemini reply unavailable",usage,failure);
    }
  }
}
