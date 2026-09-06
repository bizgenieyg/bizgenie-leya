import { env } from "../../config/env.js";
import type { AIProvider } from "./ai-provider.interface.js";
import { GeminiProvider, DEFAULT_GEMINI_MODEL } from "./gemini.provider.js";

export function createAIProvider(key = env.geminiApiKey, model = env.geminiModel): AIProvider | null {
  return key?.trim() ? new GeminiProvider(key.trim(), model?.trim() || DEFAULT_GEMINI_MODEL) : null;
}
