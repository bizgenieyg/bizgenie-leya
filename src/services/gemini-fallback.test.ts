import assert from "node:assert/strict";
import test from "node:test";
import { GeminiProvider, DEFAULT_GEMINI_MODEL } from "../providers/ai/gemini.provider.js";
import { createAIProvider } from "../providers/ai/index.js";
import { generateKnowledgeReply } from "./ai-fallback.service.js";

const context = { assistant: { assistant_name: "Лея", allowed_languages: ["he", "ru", "en"], tone: "friendly", mode: null, system_rules: null }, knowledge: [{ id: "a", question: "Часы?", answer: "9–18" }] };

test("absent key disables fallback without an API call", async () => {
  assert.equal(createAIProvider(""), null);
  assert.equal(await generateKnowledgeReply(context, "Когда?", null), null);
});
test("Gemini receives tenant knowledge/settings and hard rules, returns only final text", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`);
    assert.equal((init?.headers as Record<string, string>)["x-goog-api-key"], "test-key");
    assert.equal(String(url).includes("test-key"), false);
    assert.ok(init?.signal);
    const body = JSON.parse(String(init?.body));
    assert.match(body.systemInstruction.parts[0].text, /ТОЛЬКО на основе/);
    assert.match(body.systemInstruction.parts[0].text, /Никогда не выдумывай/);
    const input = JSON.parse(body.contents[0].parts[0].text);
    assert.deepEqual(input.knowledge, [{ question: "Часы?", answer: "9–18" }]);
    assert.deepEqual(input.assistant.languages, ["he", "ru", "en"]);
    assert.equal(input.customerMessage, "Когда?");
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ thought: true, text: "private thinking" }, { text: "С 9 до 18." }] } }] });
  };
  try { assert.equal(await generateKnowledgeReply(context, "Когда?", new GeminiProvider("test-key")), "С 9 до 18."); }
  finally { globalThis.fetch = originalFetch; }
});
test("HTTP failures, blocked/empty/partial output and timeout retain old fallback behavior", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const timeout = AbortSignal.timeout;
  const warnings: unknown[] = [];
  console.warn = (...args) => { warnings.push(args); };
  try {
    for (const response of [new Response("private secret", { status: 503 }), Response.json({}), Response.json({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "unfinished" }] } }] })]) {
      globalThis.fetch = async () => response;
      assert.equal(await generateKnowledgeReply(context, "private text", new GeminiProvider("test-key")), null);
    }
    AbortSignal.timeout = (ms: number) => { assert.equal(ms, 10000); return AbortSignal.abort(); };
    globalThis.fetch = async (_url, init) => { init?.signal?.throwIfAborted(); throw new Error("expected aborted signal"); };
    assert.equal(await generateKnowledgeReply(context, "private text", new GeminiProvider("test-key")), null);
    assert.doesNotMatch(JSON.stringify(warnings), /private|secret|test-key/);
  } finally { globalThis.fetch = originalFetch; console.warn = originalWarn; AbortSignal.timeout = timeout; }
});
