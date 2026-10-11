import { env } from "../../config/env.js";
import type { AIProvider } from "./ai-provider.interface.js";
import { GeminiProvider, DEFAULT_GEMINI_MODEL, DEFAULT_GEMINI_TASK_MODEL } from "./gemini.provider.js";
import { MissingKeyProvider } from "./missing-key.provider.js";
import { AnthropicProvider } from "./anthropic.provider.js";
import { OpenAIProvider } from "./openai.provider.js";
import { TASK_MODEL_LIMITS, THINKING_LEVELS } from "../../config/behavior.js";

/** Without a key the provider still exists and fails every call as 'missing_api_key' (an outage, not a knowledge gap). */
export function createAIProvider(key = env.geminiApiKey, model = env.geminiModel): AIProvider {
  return key?.trim() ? new GeminiProvider(key.trim(), model?.trim() || DEFAULT_GEMINI_MODEL) : new MissingKeyProvider();
}
/**
 * Task Z4: the provider by the model id prefix — 'claude-' → Anthropic, 'gpt-' → OpenAI, anything else → Gemini.
 * The key comes from ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY; without it, MissingKeyProvider.
 */
export function createModelProvider(model: string, keys: { gemini?: string | undefined; anthropic?: string | undefined; openai?: string | undefined } = { gemini: env.geminiApiKey, anthropic: env.anthropicApiKey, openai: env.openaiApiKey }): AIProvider {
  const id = model.trim();
  if (id.startsWith('claude-')) return keys.anthropic?.trim() ? new AnthropicProvider(keys.anthropic.trim(), id) : new MissingKeyProvider();
  if (id.startsWith('gpt-')) return keys.openai?.trim() ? new OpenAIProvider(keys.openai.trim(), id) : new MissingKeyProvider();
  return createAIProvider(keys.gemini, id);
}
export const modelKeyConfigured = (key = env.geminiApiKey): boolean => !!key?.trim();
/** GEMINI_TASK_MODEL for one-off tasks (knowledge extraction, audit); replies keep GEMINI_MODEL. */
export function createTaskAIProvider(key = env.geminiApiKey, model = env.geminiTaskModel): AIProvider {
  return key?.trim() ? new GeminiProvider(key.trim(), model?.trim() || DEFAULT_GEMINI_TASK_MODEL, { ...taskModelLimits(), timeoutMs: 120_000, attemptTimeoutMs: 90_000 }) : new MissingKeyProvider();
}
/** TASK_MODEL_LIMITS with the env overrides; a thinking level from env applies to the configured task model. */
export function taskModelLimits(model = env.geminiTaskModel?.trim() || DEFAULT_GEMINI_TASK_MODEL, maxTokens = env.geminiTaskMaxOutputTokens, level = env.geminiTaskThinkingLevel) {
  const cap = Number(maxTokens);
  const maxOutputTokens = Number.isSafeInteger(cap) && cap >= 1024 && cap <= 65_536 ? cap : TASK_MODEL_LIMITS.maxOutputTokens;
  const thinkingLevels = level && (THINKING_LEVELS as readonly string[]).includes(level) ? { ...TASK_MODEL_LIMITS.thinkingLevels, [model]: level } : TASK_MODEL_LIMITS.thinkingLevels;
  return { maxOutputTokens, retryMaxOutputTokens: Math.min(65_536, Math.max(maxOutputTokens * 2, TASK_MODEL_LIMITS.retryMaxOutputTokens)), thinkingLevels };
}
