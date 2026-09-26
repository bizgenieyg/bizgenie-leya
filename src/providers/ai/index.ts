import { env } from "../../config/env.js";
import type { AIProvider } from "./ai-provider.interface.js";
import { GeminiProvider, DEFAULT_GEMINI_MODEL } from "./gemini.provider.js";
import { MissingKeyProvider } from "./missing-key.provider.js";

/** Without a key the provider still exists and fails every call as 'missing_api_key' (an outage, not a knowledge gap). */
export function createAIProvider(key = env.geminiApiKey, model = env.geminiModel): AIProvider {
  return key?.trim() ? new GeminiProvider(key.trim(), model?.trim() || DEFAULT_GEMINI_MODEL) : new MissingKeyProvider();
}
export const modelKeyConfigured = (key = env.geminiApiKey): boolean => !!key?.trim();
