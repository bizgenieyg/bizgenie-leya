import assert from "node:assert/strict";
import test from "node:test";

import { WahaProvider } from "../providers/whatsapp/waha.provider.js";
import { sessionConfigForTenant } from "./waha-admin.utils.js";

const TENANT_ID = "123e4567-e89b-42d3-a456-426614174000";

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
      sessionConfigForTenant(TENANT_ID, "https://leia.example.com", "test-webhook-secret"),
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
    assert.equal((await provider.restartSession(sessionConfigForTenant(TENANT_ID, "https://leia.example.com", "webhook-secret"))).status, "SCAN_QR_CODE");
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
      sessionConfigForTenant(TENANT_ID, "https://leia.example.com", "secret")
    ), /status 401/);
    assert.equal(methods.includes("DELETE"), false);
  } finally { globalThis.fetch = originalFetch; }
});
