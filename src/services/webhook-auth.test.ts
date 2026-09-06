import assert from "node:assert/strict";
import test from "node:test";
import type { Request } from "express";
import { webhookAuthValid } from "../utils/webhook-auth.js";
import { hmacHex } from "../utils/crypto.js";

function request(headers: Record<string, string>, rawBody?: Buffer): Request {
  return { header: (name: string) => headers[name], rawBody } as unknown as Request;
}
test("webhook accepts configured token and rejects missing, wrong and cross-tenant tokens", () => {
  assert.equal(webhookAuthValid(request({ "x-webhook-token": "tenant-secret" }), "tenant-secret"), true);
  for (const headers of [{}, { "x-webhook-token": "other-tenant" }]) {
    assert.equal(webhookAuthValid(request(headers), "tenant-secret"), false);
  }
});
test("HMAC verifies raw Cyrillic/Hebrew bytes, not reserialized JSON", () => {
  const raw = Buffer.from('{ "text": "Привет שלום", "escaped": "\\u041f" }\n');
  const signature = "sha256=" + hmacHex("secret", raw);
  assert.equal(webhookAuthValid(request({ "x-hub-signature-256": signature }, raw), "secret"), true);
  assert.equal(webhookAuthValid(request({ "x-hub-signature-256": signature }, Buffer.from(JSON.stringify(JSON.parse(raw.toString())))), "secret"), false);
  assert.equal(webhookAuthValid(request({ "x-hub-signature-256": signature }), "secret"), false);
  assert.equal(webhookAuthValid(request({ "x-hub-signature-256": "invalid", "x-webhook-token": "secret" }, raw), "secret"), false);
});
