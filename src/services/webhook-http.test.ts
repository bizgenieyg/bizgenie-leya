import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { encryptCredential } from "../utils/crypto.js";

process.env.SUPABASE_URL = "https://database.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";
process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.PUBLIC_BASE_URL = "https://leia.example.com";
process.env.WAHA_URL = "https://waha.invalid";

let forcedTenantReads = 0;
let forceWorkerFailure = false;

test("actual webhook route rejects unauthenticated and wrong-token requests with HTTP 401", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith("https://database.invalid/")) return originalFetch(input, init);
    if (forceWorkerFailure && url.includes("/tenants?") && ++forcedTenantReads > 1) {
      return Response.json({ message: "private database error" }, { status: 400 });
    }
    const data = url.includes("/tenants?")
      ? { id: "123e4567-e89b-42d3-a456-426614174000", status: "active" }
      : { webhook_secret_encrypted: encryptCredential("tenant-secret", process.env.CREDENTIAL_ENCRYPTION_KEY!) };
    return Response.json(data);
  };
  const { app } = await import("../server.js");
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    for (const token of ["", "wrong-tenant-secret"]) {
      const response: Response = await originalFetch(`http://127.0.0.1:${address.port}/webhook/123e4567-e89b-42d3-a456-426614174000`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { "X-Webhook-Token": token } : {}) },
        body: '{"text":"Привет שלום"}',
      });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "Unauthorized webhook" });
    }
  } finally {
    server.close();
    server.closeAllConnections();
    globalThis.fetch = originalFetch;
  }
});

test("authenticated webhook returns 200 even when worker fails and logs event id/type/stack", async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  let tenantReads = 0;
  forceWorkerFailure = true;
  forcedTenantReads = 0;
  let capture!: (value: Record<string, unknown>) => void;
  const logged = new Promise<Record<string, unknown>>(resolve => { capture = resolve; });
  console.error = (label, details) => {
    if (label === "webhook worker failed:") capture(details);
  };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith("https://database.invalid/")) return originalFetch(input, init);
    if (url.includes("/tenants?")) {
      if (++tenantReads > 1) return Response.json({ message: "private database error" }, { status: 400 });
      return Response.json({ id: "123e4567-e89b-42d3-a456-426614174000", status: "active" });
    }
    return Response.json({ webhook_secret_encrypted: encryptCredential("tenant-secret", process.env.CREDENTIAL_ENCRYPTION_KEY!) });
  };
  const { app } = await import("../server.js");
  const server = app.listen(0, "127.0.0.1");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response: Response = await originalFetch(`http://127.0.0.1:${address.port}/webhook/123e4567-e89b-42d3-a456-426614174000`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Webhook-Token": "tenant-secret" },
      body: JSON.stringify({ id: "01arz3ndektsv4rrffq69g5fav", event: "message", payload: { from: "972500000001@c.us", fromMe: false, hasMedia: false, body: "private contents" } }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { received: true });
    const details = await Promise.race([logged, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("worker failure was not logged")), 2000);
    })]);
    assert.equal(details.eventId, "01arz3ndektsv4rrffq69g5fav");
    assert.equal(details.event, "message");
    assert.equal(details.level, "error");
    assert.match(String(details.stack), /tenant.service.js/);
    assert.match(String(details.stack), /webhook.worker.js/);
    assert.doesNotMatch(JSON.stringify(details), /private|tenant-secret|972500000001/);
  } finally {
    clearTimeout(timeout);
    server.close(); server.closeAllConnections();
    globalThis.fetch = originalFetch;
    console.error = originalError;
    forceWorkerFailure = false;
  }
});
