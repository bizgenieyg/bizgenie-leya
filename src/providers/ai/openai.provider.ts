import type { AIProvider, AIReplyInput, AIReplyResult } from './ai-provider.interface.js';
import { generateWithRetry, safeCount, type HttpModelOptions } from './http-model.js';

/**
 * Task Z4: OpenAI through the Responses API (HTTP). The conversation goes as input messages; reasoning at its
 * lowest level: 'none', or 'low' where the model rejects 'none' (gpt-6.1-sol; gpt-6 models reject 'minimal'). OpenAI caches long prompt prefixes automatically. Usage is normalised:
 * input_tokens includes cached tokens; output_tokens excludes reasoning.
 */
const LOWEST_EFFORT: Record<string, string> = { 'gpt-6.1-sol': 'low' };

export class OpenAIProvider implements AIProvider {
  constructor(private readonly apiKey: string, private readonly model: string, private readonly options: HttpModelOptions = {}) {}
  generateReply(input: AIReplyInput): Promise<AIReplyResult> {
    return generateWithRetry({
      provider: 'OpenAI', model: this.model, url: 'https://api.openai.com/v1/responses',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: (i, maxOutputTokens) => ({
        model: this.model, instructions: i.systemPrompt, max_output_tokens: maxOutputTokens, reasoning: { effort: LOWEST_EFFORT[this.model] ?? 'none' }, store: false,
        input: [...(i.history ?? []).filter(t => t.text.trim()).map(t => ({ role: t.role, content: t.text })), { role: 'user', content: i.userMessage }],
      }),
      parse: data => {
        const d = data as { status?: string; incomplete_details?: { reason?: string } | null; output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
          usage?: { input_tokens?: unknown; output_tokens?: unknown; input_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown }; output_tokens_details?: { reasoning_tokens?: unknown } } };
        const u = d.usage ?? {}, reasoning = safeCount(u.output_tokens_details?.reasoning_tokens) ?? 0, output = safeCount(u.output_tokens);
        const reason = d.incomplete_details?.reason;
        return {
          text: (d.output ?? []).filter(o => o.type === 'message').flatMap(o => o.content ?? []).filter(c => c.type === 'output_text' && typeof c.text === 'string').map(c => c.text).join(''),
          incomplete: d.status === 'completed' ? null : reason === 'max_output_tokens' ? 'max_tokens' : (reason ?? d.status ?? 'none').toLowerCase().replace(/[^a-z_]/g, '').slice(0, 30) || 'none',
          usage: { ...(safeCount(u.input_tokens) !== undefined ? { input_tokens: safeCount(u.input_tokens)! } : {}), ...(output !== undefined ? { output_tokens: output - Math.min(output, reasoning) } : {}),
            thinking_tokens: reasoning, cached_input_tokens: safeCount(u.input_tokens_details?.cached_tokens) ?? 0, cache_write_tokens: safeCount(u.input_tokens_details?.cache_write_tokens) ?? 0,
            ...(d.status ? { finish_reason: d.status } : {}) },
        };
      },
      error: data => { const e = (data as { error?: { type?: unknown; code?: unknown; message?: unknown } }).error; const s = typeof e?.code === 'string' ? e.code : e?.type; return { ...(typeof s === 'string' ? { status: s } : {}), ...(typeof e?.message === 'string' ? { message: e.message } : {}) }; },
    }, input, this.options);
  }
}
