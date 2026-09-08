import { AIProviderError, type AIUsage } from "./ai-provider.interface.js";
import type { AIProvider, AIReplyInput, AIReplyResult } from "./ai-provider.interface.js";

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

export class GeminiProvider implements AIProvider {
  constructor(private readonly apiKey: string, private readonly model = DEFAULT_GEMINI_MODEL) {}

  async generateReply(input: AIReplyInput): Promise<AIReplyResult> {
    let usage: AIUsage = { model: this.model };
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: input.systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: input.userMessage }] }],
          generationConfig: { maxOutputTokens: 1024 },
        }),
      });
      if (!response.ok) throw new Error("Gemini request failed");
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
      if (candidate?.finishReason !== "STOP") throw new Error("Gemini reply incomplete");
      const text = candidate.content?.parts?.filter(part => !part.thought && typeof part.text === "string").map(part => part.text).join("").trim();
      if (!text) throw new Error("Gemini reply empty");
      return { text, usage };
    } catch {
      // Do not expose provider error bodies, keys, prompts or message text.
      throw new AIProviderError("Gemini reply unavailable",usage);
    }
  }
}
