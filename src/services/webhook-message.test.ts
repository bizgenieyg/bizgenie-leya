import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWebhookMessage } from "../utils/webhook-message.js";
import { digitsOf, toChatId } from "../utils/whatsapp-id.js";
import { webhookFailureDetails } from "../utils/webhook-error.js";

// Redacted GOWS message shape; no production message/contact data.
const gows = {
  event: "message", session: "tenant-test",
  payload: {
    id: "false_972500000001@c.us_TEST",
    from: "972500000001@c.us", fromMe: false, body: "Часы работы?",
    author: null, participant: null, notifyName: null, replyTo: null,
    media: null, _data: { Info: { PushName: "Тест שלום", Sender: "972500000001@s.whatsapp.net" } },
  },
};
test("normalizes GOWS nullable fields and nested contact name without altering text", () => {
  const result = normalizeWebhookMessage(gows);
  assert.equal(result.kind, "message");
  if (result.kind !== "message") return;
  assert.equal(result.pushName, "Тест שלום");
  assert.equal(result.text, "Часы работы?");
  assert.equal(result.replyToId, null);
});
test("optional null/missing GOWS data never crashes normalization", () => {
  for (const _data of [null, undefined, {}, { Info: null }, { Info: { PushName: null } }]) {
    const result = normalizeWebhookMessage({ ...gows, payload: { ...gows.payload, _data, id: null } });
    assert.equal(result.kind, "message");
    if (result.kind === "message") {
      assert.equal(result.pushName, null);
      assert.equal(result.incomingMsgId, null);
    }
  }
});
test("critical null, missing or non-string fields cause a safe skip", () => {
  for (const key of ["from", "body"]) {
    for (const value of [null, undefined, "", " ", {}, 3]) {
      const result = normalizeWebhookMessage({ ...gows, payload: { ...gows.payload, [key]: value } });
      assert.equal(result.kind, "invalid");
    }
  }
  assert.equal(normalizeWebhookMessage({ event: "message", payload: null }).kind, "invalid");
});
test("nullable owner phone does not throw replace or produce an empty chat address", () => {
  for (const value of [null, undefined, "", {}]) {
    assert.equal(digitsOf(value), "");
    assert.equal(toChatId(value), "");
  }
  assert.equal(digitsOf("+972 50-123-4567"), "972501234567");
});
test("worker diagnostics include event and stack frames but exclude error message/payload", () => {
  const error = new TypeError(`private message token=secret
private second line`);
  const details = webhookFailureDetails(error, { event: "message", payload: "private body" });
  assert.equal(details.event, "message");
  assert.equal(details.errorType, "TypeError");
  assert.match(details.stack, /webhook-message.test/);
  assert.doesNotMatch(JSON.stringify(details), /private|secret/);
});

test("failure log preserves WAHA event id and every captured stack frame", () => {
  const error = new Error("private contents");
  const frames = Array.from({ length: 40 }, (_, i) => `    at worker${i} (/app/dist/worker.js:${i + 1}:1)`);
  error.stack = ["Error: private contents", ...frames].join("\n");
  const result = webhookFailureDetails(error, { id: "01arz3ndektsv4rrffq69g5fav", event: "message.any" });
  assert.equal(result.eventId, "01arz3ndektsv4rrffq69g5fav");
  assert.equal(result.eventIdSource, "waha");
  assert.equal(result.event, "message.any");
  assert.equal(result.level, "error");
  assert.equal(result.stack.split("\n").length, 41);
});
test("missing envelope id gets a correlation id without using message id", () => {
  const result = webhookFailureDetails(new Error("private"), { event: "message", payload: { id: "private message id" } });
  assert.equal(result.eventIdSource, "generated");
  assert.match(result.eventId, /^[a-f0-9-]{36}$/);
  assert.doesNotMatch(JSON.stringify(result), /private/);
});
