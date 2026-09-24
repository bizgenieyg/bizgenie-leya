import assert from "node:assert/strict";
import test from "node:test";

import { WahaProvider } from "../providers/whatsapp/waha.provider.js";
import type { DatabaseClient } from "../db/supabase.js";
import { WahaAdminService } from "./waha-admin.service.js";
import { sessionConfigForTenant } from "./waha-admin.utils.js";

const TENANT_ID = "123e4567-e89b-42d3-a456-426614174000";

test('WAHA seen and typing endpoints use GOWS payloads and every request has a timeout', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown>; signal: AbortSignal | null | undefined }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown>, signal: init?.signal });
    return Response.json({ id: 'sent-1' });
  };
  try {
    const provider = new WahaProvider('http://waha.internal');
    await provider.sendSeen({ session: 'business', chatId: '972500000001@c.us', messageIds: ['incoming-1'] });
    await provider.startTyping({ session: 'business', chatId: '972500000001@c.us' });
    await provider.stopTyping({ session: 'business', chatId: '972500000001@c.us' });
    await provider.sendMessage({ session: 'business', chatId: '972500000001@c.us', text: 'Hello' });
    assert.deepEqual(calls.map(call => call.url.replace('http://waha.internal', '')), ['/api/sendSeen','/api/startTyping','/api/stopTyping','/api/sendText']);
    assert.deepEqual(calls[0]!.body.messagesIds, ['incoming-1']);
    assert.ok(calls.every(call => call.signal instanceof AbortSignal));
  } finally { globalThis.fetch = originalFetch; }
});

test("WAHA start sends the shared-container session config without exposing its key", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(JSON.stringify({ status: "STARTING" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const provider = new WahaProvider("http://waha.internal/", "container-secret");
    const result = await provider.startSession(
      sessionConfigForTenant(TENANT_ID, "https://leya.example.com", "test-webhook-secret"),
    );

    assert.equal(capturedUrl, "http://waha.internal/api/sessions");
    assert.equal(capturedInit?.method, "POST");
    const body = JSON.parse(String(capturedInit?.body));
    assert.equal(body.start, true);
    assert.equal(body.config.markOnline, false);
    assert.deepEqual(body.config.webhooks[0].customHeaders, [{ name: "X-Webhook-Token", value: "test-webhook-secret" }]);
    assert.equal(
      (capturedInit?.headers as Record<string, string>)["X-Api-Key"],
      "container-secret",
    );
    assert.deepEqual(result, { status: "STARTING" });
    assert.equal(JSON.stringify(result).includes("container-secret"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("WAHA QR request returns binary image data", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(Uint8Array.from([137, 80, 78, 71]), {
      status: 200,
      headers: { "Content-Type": "image/png" },
    });

  try {
    const provider = new WahaProvider("http://waha.internal", "container-secret");
    const qr = await provider.getQrImage(`tenant-${TENANT_ID}`);
    assert.equal(qr.contentType, "image/png");
    assert.deepEqual([...qr.data], [137, 80, 78, 71]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("restart updates webhook config before starting an existing STOPPED session", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push(`${init?.method} ${url}`);
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      assert.equal(body.config.markOnline, false);
      assert.equal(body.config.webhooks[0].customHeaders[0].value, "webhook-secret");
    }
    return Response.json({ status: "SCAN_QR_CODE" });
  };
  try {
    const provider = new WahaProvider("http://waha.internal");
    assert.equal((await provider.restartSession(sessionConfigForTenant(TENANT_ID, "https://leya.example.com", "webhook-secret"))).status, "SCAN_QR_CODE");
    const base = `http://waha.internal/api/sessions/tenant-${TENANT_ID}`;
    assert.deepEqual(calls, [`POST ${base}/stop`, `PUT ${base}`, `POST ${base}/start`, `GET ${base}`]);
  } finally { globalThis.fetch = originalFetch; }
});

test("restart does not delete or recreate when WAHA authorization fails", async () => {
  const originalFetch = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = async (_url, init) => {
    methods.push(String(init?.method));
    return new Response("secret upstream body", { status: 401 });
  };
  try {
    await assert.rejects(new WahaProvider("http://waha.internal").restartSession(
      sessionConfigForTenant(TENANT_ID, "https://leya.example.com", "secret")
    ), /status 401/);
    assert.equal(methods.includes("DELETE"), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("only HTTP 404 is treated as a missing session", async () => {
  const { SessionNotFoundError } = await import("../providers/whatsapp/whatsapp-provider.interface.js");
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [404, 401, 500]) {
      globalThis.fetch = async () => new Response("", { status });
      await assert.rejects(new WahaProvider("http://waha.internal").getSessionStatus("tenant"), (error: unknown) =>
        status === 404 ? error instanceof SessionNotFoundError : error instanceof Error && !(error instanceof SessionNotFoundError));
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("FAILED exposes a safe explanation for WAHA engine errors without raw details", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ status: "FAILED", engine: { gows: { error: { message: "private-key-url" } } } });
  try {
    const result = await new WahaProvider("http://waha.internal").getSessionStatus("tenant");
    assert.equal(result.reason, "waha_status_unavailable");
    assert.equal(JSON.stringify(result).includes("private-key"), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("session status reads both me.id and me.lid without returning other credentials", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    assert.ok(init?.signal);
    return Response.json({ status: "WORKING", me: { id: "972500000001@c.us", lid: "261885798707406@lid", pushName: "private" }, config: { secret: "private" } });
  };
  try {
    const result = await new WahaProvider("http://waha.internal").getSessionStatus("tenant");
    assert.deepEqual(result.me, { id: "972500000001@c.us", lid: "261885798707406@lid" });
    assert.doesNotMatch(JSON.stringify(result), /private/);
  } finally { globalThis.fetch = originalFetch; }
});

test("group list uses the GOWS endpoint and normalizes current response shapes", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = async (url, init) => {
    capturedUrl = String(url);
    assert.equal(init?.method, "GET");
    assert.ok(init?.signal);
    return Response.json([
      { JID: "1203631@g.us", Name: "Pilot team", ParticipantCount: 12 },
      { id: "1203632@g.us", subject: "Sales", participants: [{ id: "1" }, { id: "2" }], timestamp: 1_700_000_000 },
      { JID: "1203633@g.us", Name: "", ParticipantCount: 0, Participants: [{ id: "1" }, { id: "2" }, { id: "3" }] },
    ]);
  };
  try {
    const groups = await new WahaProvider("http://waha.internal", "secret").getGroups("tenant / one");
    assert.equal(capturedUrl, "http://waha.internal/api/tenant%20%2F%20one/groups?sortBy=subject&sortOrder=asc");
    assert.deepEqual(groups, [
      { id: "1203631@g.us", name: "Pilot team", participantsCount: 12 },
      { id: "1203632@g.us", name: "Sales", participantsCount: 2, lastActivityAt: "2023-11-14T22:13:20.000Z" },
      { id: "1203633@g.us", name: "Без названия", participantsCount: 3 },
    ]);
  } finally { globalThis.fetch = originalFetch; }
});

test("group directory reads paged chats and sorts by conversation activity", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async url => {
    const path = String(url);
    urls.push(path);
    if (path.includes("/groups?")) return Response.json([
      { JID: "older@g.us", Name: "Older", ParticipantCount: 2 },
      { JID: "newer@g.us", Name: "Newer", ParticipantCount: 3 },
      { JID: "none@g.us", Name: "No activity", ParticipantCount: 1 },
    ]);
    if (path.includes("offset=0")) return Response.json([
      { id: "older@g.us", conversationTimestamp: 1_700_000_000 },
      { id: "newer@g.us", conversationTimestamp: 1_700_000_100 },
    ]);
    return Response.json([]);
  };
  const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { session_name: "test" }, error: null }) }) }) }) } as unknown as DatabaseClient;
  try {
    const service = new WahaAdminService(db, new WahaProvider("http://waha.internal"), "https://example.com", "http://waha.internal");
    const first = await service.groups(TENANT_ID);
    assert.deepEqual(first.groups.map(group => [group.id, group.lastActivityAt]), [
      ["newer@g.us", "2023-11-14T22:15:00.000Z"],
      ["older@g.us", "2023-11-14T22:13:20.000Z"],
      ["none@g.us", undefined],
    ]);
    assert.equal(urls.filter(url => url.includes("/chats?")).length, 2);
    await service.groups(TENANT_ID);
    assert.equal(urls.length, 3, "groups and chat activity share the cache");
  } finally { globalThis.fetch = originalFetch; }
});

test("group directory falls back to names when chats fail or return a non-array", async () => {
  const originalFetch = globalThis.fetch;
  const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { session_name: "test" }, error: null }) }) }) }) } as unknown as DatabaseClient;
  try {
    for (const failure of [new Response("", { status: 500 }), Response.json({ unexpected: true })]) {
      globalThis.fetch = async url => String(url).includes("/groups?")
        ? Response.json([{ JID: "z@g.us", Name: "Zulu" }, { JID: "a@g.us", Name: "Alpha" }])
        : failure;
      const service = new WahaAdminService(db, new WahaProvider("http://waha.internal"), "https://example.com", "http://waha.internal");
      assert.deepEqual((await service.groups(TENANT_ID)).groups.map(group => [group.name, group.lastActivityAt]),
        [["Alpha", undefined], ["Zulu", undefined]]);
    }
  } finally { globalThis.fetch = originalFetch; }
});
