import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { encryptCredential } from "../utils/crypto.js";

process.env.SUPABASE_URL = "https://database.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";
process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.PUBLIC_BASE_URL = "https://leia.example.com";
process.env.WAHA_URL = "https://waha.invalid";

test("actual webhook route rejects unauthenticated and wrong-token requests with HTTP 401", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith("https://database.invalid/")) return originalFetch(input, init);
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
