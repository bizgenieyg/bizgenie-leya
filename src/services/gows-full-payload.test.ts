import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { filterIncoming, parseAllowlist, ownerIdentityField, readSessionIdentity } from "../utils/incoming-policy.js";
import { normalizeWebhookMessage } from "../utils/webhook-message.js";

// Complete persisted production payloads, redacted without dropping fields.
const incoming = JSON.parse(readFileSync("src/services/fixtures/gows-incoming-lid.json", "utf8"));
const group = JSON.parse(readFileSync("src/services/fixtures/gows-incoming-group.json", "utf8"));
const policy = parseAllowlist("false");

test("entire real GOWS 2026.7.2 LID/app payload passes every early filter and normalization", () => {
  assert.equal(incoming.environment.version, "2026.7.2");
  assert.equal(incoming.payload.source, "app");
  assert.equal(filterIncoming(incoming, policy).allowed, true);
  assert.equal(normalizeWebhookMessage(incoming).kind, "message");
  assert.equal(ownerIdentityField(incoming.payload.from, readSessionIdentity(incoming.me)), null);
  assert.equal(filterIncoming(group, policy).allowed, false);
});
for (const field of ["fromMe", "IsFromMe"]) {
  test(`explicit ${field}=true alone blocks with safe decision evidence`, () => {
    const body = structuredClone(incoming);
    if (field === "fromMe") body.payload.fromMe = true;
    else body.payload._data.Info.IsFromMe = true;
    const result = filterIncoming(body, policy);
    assert.equal(result.allowed, false);
    if (result.allowed) return;
    assert.equal(result.reason, "outgoing_message");
    assert.equal(result.field, field === "fromMe" ? "payload.fromMe" : "payload._data.Info.IsFromMe");
    assert.equal(result.value, true);
    assert.doesNotMatch(JSON.stringify(result), /972500000003|Часы работы/);
  });
}
test("absent/null direction flags and app source remain incoming through ALL filters", () => {
  for (const value of [null, undefined]) {
    const body = structuredClone(incoming);
    body.payload.fromMe = value;
    body.payload._data.Info.IsFromMe = value;
    assert.equal(filterIncoming(body, policy).allowed, true);
    assert.equal(normalizeWebhookMessage(body).kind, "message");
  }
});
test("full LID fixture still obeys allowlist and group/system restrictions", () => {
  const result = filterIncoming(incoming, parseAllowlist("true", "972500000003"));
  assert.equal(result.allowed, false);
  if (!result.allowed) assert.equal(result.reason, "allowlist_unresolved");
  for (const suffix of ["@g.us", "@broadcast", "@newsletter"]) {
    const body = structuredClone(incoming);
    body.payload.from = `972500000003${suffix}`;
    const rejected = filterIncoming(body, policy);
    assert.equal(rejected.allowed, false);
    if (!rejected.allowed) assert.equal(rejected.value, suffix);
  }
});
