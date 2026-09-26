import { AIProviderError, type AIFailure, type AIUsage } from "./ai-provider.interface.js";
import { recordModelOutcome } from "../../services/model-health.service.js";
import type { AIProvider, AIReplyInput, AIReplyResult } from "./ai-provider.interface.js";

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

export class GeminiProvider implements AIProvider {
  constructor(private readonly apiKey: string, private readonly model = DEFAULT_GEMINI_MODEL) {}

  async generateReply(input: AIReplyInput): Promise<AIReplyResult> {
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
      const overall = AbortSignal.timeout(20_000);
      let response: Response | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
            redirect: "error",
            signal: AbortSignal.any([overall, AbortSignal.timeout(9_000)]),
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: input.systemPrompt }] },
              contents: [{ role: "user", parts: [{ text: input.userMessage }] }],
              generationConfig: { maxOutputTokens: 1024 },
            }),
          });
        } catch {
          if (attempt || overall.aborted) { failure = { reason: overall.aborted ? 'timeout' : 'network' }; throw new Error('Gemini network unavailable'); }
          await new Promise(resolve => setTimeout(resolve, 1_500));
          continue;
        }
        if (response.ok) break;
        if (attempt || !(response.status === 429 || response.status >= 500) || overall.aborted) throw await fail(response, `http_${response.status}`);
        await new Promise(resolve => setTimeout(resolve, 1_500));
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
      return { text, usage };
    } catch {
      // Operational codes only: never the prompt, the client's text or the key.
      console.error('model_call_failed', { model: this.model, ...failure });
      recordModelOutcome(false, failure);
      throw new AIProviderError("Gemini reply unavailable",usage,failure);
    }
  }
}
