import assert from "node:assert/strict";
import test from "node:test";
import { allowedRecipient, filterIncoming, parseAllowlist } from "../utils/incoming-policy.js";
const payload = { from: "972500000001@c.us", fromMe: false, hasMedia: false, body: "private text", _data: { Info: { Chat: "972500000001@s.whatsapp.net", IsGroup: false, IsFromMe: false }, Message: { conversation: "private text" } } };
const off = parseAllowlist();
test("documented GOWS private text is accepted", () => {
  assert.equal(filterIncoming({ event: "message", payload }, off).allowed, true);
});
for (const [name, patch] of Object.entries({
  group: { from: "120363000000@g.us", participant: "972500000001@c.us" },
  rawGroup: { _data: { Info: { Chat: "120363000000@g.us", IsGroup: true } } },
  outgoing: { fromMe: true }, unknownDirection: { fromMe: null },
  rawOutgoing: { _data: { Info: { IsFromMe: true } } },
  status: { from: "status@broadcast" }, broadcast: { from: "123456789@broadcast" },
  channel: { from: "123456789@newsletter" }, lid: { from: "123456789@lid" },
  mediaCaption: { hasMedia: true }, location: { location: { latitude: 1 } },
  contact: { vCards: ["private vcard"] }, empty: { body: "" },
  reaction: { _data: { Message: { reactionMessage: { text: "x" } } } },
  edited: { _data: { Message: { protocolMessage: { editedMessage: { conversation: "x" } } } } },
})) {
  test(`rejects ${name}`, () => assert.equal(filterIncoming({ event: "message", payload: { ...payload, ...patch } }, off).allowed, false));
}
test("system and missing event types are rejected", () => {
  for (const event of [undefined, "session.status", "message.reaction"]) assert.equal(filterIncoming({ event, payload }, off).allowed, false);
});
test("allowlist is fail-closed, accepts exact international numbers only", () => {
  const policy = parseAllowlist("true", "+972 50-000-0001, +972500000002");
  assert.equal(filterIncoming({ event: "message", payload }, policy).allowed, true);
  assert.equal(filterIncoming({ event: "message", payload: { ...payload, from: "972500000003@c.us", _data: null } }, policy).allowed, false);
  assert.equal(allowedRecipient("+972500000003", policy), false);
  assert.equal(allowedRecipient("120363000000@g.us", policy), false);
  assert.equal(allowedRecipient("972500000001@c.us", parseAllowlist("true", "")), false);
  assert.equal(allowedRecipient("972500000001@c.us", parseAllowlist("typo", "invalid")), false);
});
