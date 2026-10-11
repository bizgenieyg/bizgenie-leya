import assert from 'node:assert/strict';
import test from 'node:test';
import { AnthropicProvider } from '../providers/ai/anthropic.provider.js';
import { OpenAIProvider } from '../providers/ai/openai.provider.js';
import { GeminiProvider } from '../providers/ai/gemini.provider.js';
import { MissingKeyProvider } from '../providers/ai/missing-key.provider.js';
import { createModelProvider } from '../providers/ai/index.js';
import { withFallback } from '../providers/ai/fallback.provider.js';
import { AIProviderError } from '../providers/ai/ai-provider.interface.js';
import { callCost, priceFor } from '../config/model-prices.js';

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
async function withFetch(responses: Response[], run: (calls: Call[]) => Promise<void>) {
  const original = globalThis.fetch, calls: Call[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => { calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) }); return responses.shift()!; }) as typeof fetch;
  const error = console.error, warn = console.warn; console.error = () => {}; console.warn = () => {};
  try { await run(calls); } finally { globalThis.fetch = original; console.error = error; console.warn = warn; }
}
const history = [{ role: 'user' as const, text: 'привет' }, { role: 'assistant' as const, text: 'Здравствуйте!' }, { role: 'assistant' as const, text: 'Чем занимаетесь?' }];
const claude = (text: string, stop = 'end_turn', usage: Record<string, unknown> = { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 20, output_tokens_details: { thinking_tokens: 0 } }) =>
  json({ content: [{ type: 'text', text }], stop_reason: stop, usage });
const gpt = (text: string, status = 'completed', reason: string | null = null) => json({ status, incomplete_details: reason ? { reason } : null,
  output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text }] }],
  usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 800, cache_write_tokens: 0 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 10 } } });

test('Z4 Anthropic: chat turns merged by role, thinking off per model, cached system prompt, usage normalised', async () => {
  await withFetch([claude('Ответ'), claude('Ответ')], async calls => {
    const haiku = await new AnthropicProvider('k', 'claude-haiku-5-5').generateReply({ systemPrompt: 'Ядро + инструкция + факты', userMessage: 'сколько стоит?', history, generation: { maxOutputTokens: 2048 } });
    await new AnthropicProvider('k', 'claude-sonnet-5-5').generateReply({ systemPrompt: 's', userMessage: 'u' });
    const body = calls[0]!.body;
    assert.equal(calls[0]!.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(calls[0]!.headers['x-api-key'], 'k'); assert.equal(calls[0]!.headers['anthropic-version'], '2023-06-01');
    assert.deepEqual(body.thinking, { type: 'disabled' }); assert.equal(body.max_tokens, 2048);
    assert.deepEqual(body.system, [{ type: 'text', text: 'Ядро + инструкция + факты', cache_control: { type: 'ephemeral' } }]);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'привет' }, { role: 'assistant', content: 'Здравствуйте!\n\nЧем занимаетесь?' }, { role: 'user', content: 'сколько стоит?' }]);
    assert.deepEqual(calls[1]!.body.thinking, { type: 'between_tools' }, 'Sonnet 5.5 rejects disabled');
    assert.equal(haiku.text, 'Ответ');
    assert.deepEqual(haiku.usage, { model: 'claude-haiku-5-5', input_tokens: 1000, output_tokens: 20, thinking_tokens: 0, cached_input_tokens: 900, cache_write_tokens: 0, finish_reason: 'end_turn' });
  });
});

test('Z4 Anthropic: max_tokens → one retry with the larger cap; 529 → one retry; error message masks keys', async () => {
  await withFetch([claude('', 'max_tokens'), claude('Готово')], async calls => {
    const r = await new AnthropicProvider('k', 'claude-haiku-5-5').generateReply({ systemPrompt: 's', userMessage: 'u', generation: { maxOutputTokens: 2048, retryMaxOutputTokens: 4096 } });
    assert.equal(r.text, 'Готово'); assert.deepEqual(calls.map(c => c.body.max_tokens), [2048, 4096]);
  });
  await withFetch([json({ error: { type: 'overloaded_error', message: 'busy' } }, 529), json({ error: { type: 'overloaded_error', message: 'bad key sk-ant-abcdefghijklmnop' } }, 529)], async calls => {
    await assert.rejects(new AnthropicProvider('k', 'claude-haiku-5-5').generateReply({ systemPrompt: 's', userMessage: 'u' }), (e: AIProviderError) =>
      e.failure.reason === 'http_529' && e.failure.providerStatus === 'overloaded_error' && e.failure.providerMessage === 'bad key [key]');
    assert.equal(calls.length, 2);
  });
  await withFetch([json({ error: { type: 'invalid_request_error', message: 'bad' } }, 400)], async calls => {
    await assert.rejects(new AnthropicProvider('k', 'claude-haiku-5-5').generateReply({ systemPrompt: 's', userMessage: 'u' }), (e: AIProviderError) => e.failure.reason === 'http_400');
    assert.equal(calls.length, 1, '4xx is not retried');
  });
});

test('Z4 OpenAI: Responses API, reasoning none, chat input, usage without reasoning in output; incomplete → retry', async () => {
  await withFetch([gpt('Ответ'), gpt('Ответ')], async calls => {
    const r = await new OpenAIProvider('k', 'gpt-6-luna').generateReply({ systemPrompt: 'Ядро', userMessage: 'сколько?', history, generation: { maxOutputTokens: 2048 } });
    const body = calls[0]!.body;
    assert.equal(calls[0]!.url, 'https://api.openai.com/v1/responses'); assert.equal(calls[0]!.headers.Authorization, 'Bearer k');
    assert.deepEqual(body.reasoning, { effort: 'none' }); assert.equal(body.instructions, 'Ядро'); assert.equal(body.max_output_tokens, 2048); assert.equal(body.store, false);
    assert.deepEqual(body.input, [{ role: 'user', content: 'привет' }, { role: 'assistant', content: 'Здравствуйте!' }, { role: 'assistant', content: 'Чем занимаетесь?' }, { role: 'user', content: 'сколько?' }]);
    await new OpenAIProvider('k', 'gpt-6.1-sol').generateReply({ systemPrompt: 's', userMessage: 'u' });
    assert.deepEqual(calls[1]!.body.reasoning, { effort: 'low' }, 'gpt-6.1-sol rejects none');
    assert.deepEqual(r.usage, { model: 'gpt-6-luna', input_tokens: 1000, output_tokens: 20, thinking_tokens: 10, cached_input_tokens: 800, cache_write_tokens: 0, finish_reason: 'completed' });
  });
  await withFetch([gpt('', 'incomplete', 'max_output_tokens'), gpt('Готово')], async calls => {
    const r = await new OpenAIProvider('k', 'gpt-6-luna').generateReply({ systemPrompt: 's', userMessage: 'u', generation: { maxOutputTokens: 2048, retryMaxOutputTokens: 4096 } });
    assert.equal(r.text, 'Готово'); assert.deepEqual(calls.map(c => c.body.max_output_tokens), [2048, 4096]);
  });
});

test('Z4: the provider by the model prefix; no key → MissingKeyProvider', () => {
  const keys = { gemini: 'g', anthropic: 'a', openai: 'o' };
  assert.ok(createModelProvider('claude-haiku-5-5', keys) instanceof AnthropicProvider);
  assert.ok(createModelProvider('gpt-6-luna', keys) instanceof OpenAIProvider);
  assert.ok(createModelProvider('gemini-3.8-flash', keys) instanceof GeminiProvider);
  assert.ok(createModelProvider('claude-haiku-5-5', { ...keys, anthropic: '' }) instanceof MissingKeyProvider);
  assert.ok(createModelProvider('gpt-6-luna', { ...keys, openai: undefined }) instanceof MissingKeyProvider);
});

test('Z4 fallback: an outage of the primary → one call to the fallback, logged; an incomplete answer is not an outage', async () => {
  const warnings: unknown[][] = [], warn = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a); };
  try {
    const failing = (reason: string) => ({ async generateReply(): Promise<never> { throw new AIProviderError('x', undefined, { reason }); } });
    let fallbackCalls = 0;
    const fallback = { async generateReply() { fallbackCalls++; return { text: 'с запасной' }; } };
    for (const reason of ['timeout', 'unavailable', 'http_503', 'network']) {
      const r = await withFallback(failing(reason), fallback, { primary: 'gemini-3.8-flash', fallback: 'claude-haiku-5-5' }).generateReply({ systemPrompt: 's', userMessage: 'u' });
      assert.equal(r.text, 'с запасной');
    }
    assert.equal(fallbackCalls, 4);
    assert.deepEqual(warnings[0], ['model_fallback', { model: 'gemini-3.8-flash', fallback: 'claude-haiku-5-5', reason: 'timeout' }]);
    for (const reason of ['incomplete_max_tokens', 'http_400', 'missing_api_key']) {
      await assert.rejects(withFallback(failing(reason), fallback, { primary: 'a', fallback: 'b' }).generateReply({ systemPrompt: 's', userMessage: 'u' }));
    }
    assert.equal(fallbackCalls, 4, 'not an outage — no fallback');
  } finally { console.warn = warn; }
});

test('Z4 prices: tiers by date and prompt size, cache reads and writes, unknown model has no price', () => {
  const dec = new Date('2026-12-31T12:00:00Z'), jan = new Date('2027-01-01T00:00:00Z');
  assert.equal(priceFor('gemini-3.8-flash', dec, 1000)!.input, 0.75);
  assert.equal(priceFor('gemini-3.8-flash', jan, 1000)!.input, 1.5);
  assert.equal(priceFor('claude-haiku-5-5', dec, 100_000)!.input, 0.1);
  assert.equal(priceFor('claude-haiku-5-5', dec, 100_001)!.input, 0.5);
  assert.equal(priceFor('gpt-6.1-sol', dec, 300_000)!.output, 15);
  assert.equal(priceFor('gpt-unknown', dec, 10), null);
  assert.equal(callCost('gpt-unknown', dec, { input: 1, output: 1, thinking: 0, cacheRead: 0, cacheWrite: 0 }), null);
  // Z3 final run tokens on gemini-3.8-flash: ≈ $0.71 now, ≈ $1.42 from 2027.
  const z3 = { input: 876_634, output: 10_831, thinking: 3_122, cacheRead: 0, cacheWrite: 0 };
  assert.equal(callCost('gemini-3.8-flash', dec, z3)!.toFixed(2), '0.71');
  assert.equal(callCost('gemini-3.8-flash', jan, z3)!.toFixed(2), '1.42');
  // Haiku: 100 uncached + 900 cache read + 0 written, 20 out = (100*0.1 + 900*0.01 + 20*0.5)/1e6
  assert.equal(callCost('claude-haiku-5-5', dec, { input: 1000, output: 20, thinking: 0, cacheRead: 900, cacheWrite: 0 }), (100 * 0.1 + 900 * 0.01 + 20 * 0.5) / 1e6);
  assert.equal(callCost('claude-haiku-5-5', dec, { input: 1000, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 1000 }), 1000 * 0.125 / 1e6);
});
