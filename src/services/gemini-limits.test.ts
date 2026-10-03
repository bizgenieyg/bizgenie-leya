import assert from 'node:assert/strict';
import test from 'node:test';
import { GeminiProvider } from '../providers/ai/gemini.provider.js';
import { taskModelLimits } from '../providers/ai/index.js';

const reply = (finishReason: string, text = 'Ответ') => new Response(JSON.stringify({ candidates: [{ finishReason, content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 900 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });

async function withFetch(responses: Response[], run: (bodies: Array<{ generationConfig: Record<string, unknown> }>) => Promise<void>) {
  const original = globalThis.fetch, bodies: Array<{ generationConfig: Record<string, unknown> }> = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return responses.shift()!; }) as typeof fetch;
  try { await run(bodies); } finally { globalThis.fetch = original; }
}

test('Z2: thinkingConfig only for a listed model; per-call caps override the provider options', async () => {
  await withFetch([reply('STOP'), reply('STOP')], async bodies => {
    const generation = { maxOutputTokens: 2048, thinkingLevels: { 'gemini-3.8-flash': 'low' } };
    await new GeminiProvider('k', 'gemini-3.8-flash').generateReply({ systemPrompt: 's', userMessage: 'u', generation });
    await new GeminiProvider('k', 'gemini-3.5-flash-lite').generateReply({ systemPrompt: 's', userMessage: 'u', generation });
    assert.deepEqual(bodies[0]!.generationConfig, { maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: 'low' } });
    assert.deepEqual(bodies[1]!.generationConfig, { maxOutputTokens: 2048 }, 'a model not listed keeps its own thinking default');
  });
});

test('Z2: MAX_TOKENS → one retry with the larger cap, logged with the reason, not counted as an outage', async () => {
  const warnings: unknown[][] = [], errors: unknown[][] = [];
  const warn = console.warn, error = console.error;
  console.warn = (...a: unknown[]) => { warnings.push(a); }; console.error = (...a: unknown[]) => { errors.push(a); };
  try {
    await withFetch([reply('MAX_TOKENS', ''), reply('STOP', 'Готово')], async bodies => {
      const result = await new GeminiProvider('k', 'gemini-3.8-flash').generateReply({ systemPrompt: 's', userMessage: 'u', generation: { maxOutputTokens: 2048, retryMaxOutputTokens: 4096 } });
      assert.equal(result.text, 'Готово');
      assert.deepEqual(bodies.map(b => b.generationConfig.maxOutputTokens), [2048, 4096]);
    });
    assert.deepEqual(warnings.find(w => w[0] === 'model_retry_max_tokens')?.[1], { model: 'gemini-3.8-flash', from: 2048, to: 4096 });
    assert.equal(errors.length, 0);
    await withFetch([reply('MAX_TOKENS', ''), reply('MAX_TOKENS', '')], async bodies => {
      await assert.rejects(new GeminiProvider('k', 'gemini-3.8-flash').generateReply({ systemPrompt: 's', userMessage: 'u', generation: { maxOutputTokens: 2048, retryMaxOutputTokens: 4096 } }), (e: { failure?: { reason?: string } }) => e.failure?.reason === 'incomplete_max_tokens');
      assert.equal(bodies.length, 2, 'only one retry');
    });
  } finally { console.warn = warn; console.error = error; }
});

test('Z2: task model limits — config defaults, env overrides validated', () => {
  assert.deepEqual(taskModelLimits('gemini-3.8-flash', undefined, undefined), { maxOutputTokens: 16384, retryMaxOutputTokens: 32768, thinkingLevels: { 'gemini-3.8-flash': 'low' } });
  assert.deepEqual(taskModelLimits('gemini-x', '20000', 'minimal'), { maxOutputTokens: 20000, retryMaxOutputTokens: 40000, thinkingLevels: { 'gemini-3.8-flash': 'low', 'gemini-x': 'minimal' } });
  assert.equal(taskModelLimits('gemini-3.8-flash', 'много', 'huge').maxOutputTokens, 16384);
  assert.deepEqual(taskModelLimits('gemini-3.8-flash', 'много', 'huge').thinkingLevels, { 'gemini-3.8-flash': 'low' });
});
