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
      sessionConfigForTenant(TENANT_ID, "https://leia.example.com"),
    );

    assert.equal(capturedUrl, "http://waha.internal/api/sessions/start");
    assert.equal(capturedInit?.method, "POST");
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
