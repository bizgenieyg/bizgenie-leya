import type { AIProvider, AIReplyInput, AIReplyResult } from './ai-provider.interface.js';
import { generateWithRetry, safeCount, type HttpModelOptions } from './http-model.js';

/**
 * Task Z4: Claude through the Messages API (HTTP, like the Gemini provider). The conversation goes as chat turns;
 * thinking off: 'disabled', or 'between_tools' on models that reject 'disabled' (Sonnet 5.5). The system prompt
 * (core + instruction + facts) carries cache_control: repeated turns read it from the cache. Usage is normalised:
 * input_tokens includes cache reads and writes; output_tokens excludes thinking.
 */
const THINKING_OFF: Record<string, { type: string }> = { 'claude-sonnet-5-5': { type: 'between_tools' } };
const STOP_INCOMPLETE: Record<string, string> = { max_tokens: 'max_tokens', refusal: 'refusal', pause_turn: 'pause_turn' };

export class AnthropicProvider implements AIProvider {
  constructor(private readonly apiKey: string, private readonly model: string, private readonly options: HttpModelOptions = {}) {}
  generateReply(input: AIReplyInput): Promise<AIReplyResult> {
    return generateWithRetry({
      provider: 'Anthropic', model: this.model, url: 'https://api.anthropic.com/v1/messages',
      headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      body: (i, maxOutputTokens) => ({
        model: this.model, max_tokens: maxOutputTokens, thinking: THINKING_OFF[this.model] ?? { type: 'disabled' },
        system: [{ type: 'text', text: i.systemPrompt, cache_control: { type: 'ephemeral' } }],
        // Claude needs alternating turns starting with the user: merge neighbours of the same role.
        messages: [...(i.history ?? []).filter(t => t.text.trim()).map(t => ({ role: t.role, text: t.text })), { role: 'user' as const, text: i.userMessage }]
          .reduce<Array<{ role: 'user' | 'assistant'; content: string }>>((out, t) => {
            const last = out.at(-1);
            if (last && last.role === t.role) last.content += `\n\n${t.text}`; else if (out.length || t.role === 'user') out.push({ role: t.role, content: t.text });
            return out;
          }, []),
      }),
      parse: data => {
        const d = data as { stop_reason?: string; content?: Array<{ type?: string; text?: string }>; usage?: Record<string, unknown> & { output_tokens_details?: { thinking_tokens?: unknown } } };
        const u = d.usage ?? {}, read = safeCount(u.cache_read_input_tokens) ?? 0, write = safeCount(u.cache_creation_input_tokens) ?? 0;
        const thinking = safeCount(u.output_tokens_details?.thinking_tokens) ?? 0, output = safeCount(u.output_tokens);
        return {
          text: (d.content ?? []).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join(''),
          incomplete: d.stop_reason && d.stop_reason in STOP_INCOMPLETE ? STOP_INCOMPLETE[d.stop_reason]! : null,
          usage: { input_tokens: (safeCount(u.input_tokens) ?? 0) + read + write, ...(output !== undefined ? { output_tokens: output - Math.min(output, thinking) } : {}),
            thinking_tokens: thinking, cached_input_tokens: read, cache_write_tokens: write, ...(d.stop_reason ? { finish_reason: d.stop_reason } : {}) },
        };
      },
      error: data => { const e = (data as { error?: { type?: unknown; message?: unknown } }).error; return { ...(typeof e?.type === 'string' ? { status: e.type } : {}), ...(typeof e?.message === 'string' ? { message: e.message } : {}) }; },
    }, input, this.options);
  }
}
