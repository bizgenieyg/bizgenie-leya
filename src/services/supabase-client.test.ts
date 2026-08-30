import assert from "node:assert/strict";
import test from "node:test";

import { createDatabaseClient } from "../db/postgrest.js";

test("database client does not construct or expose a Realtime client", () => {
  const client = createDatabaseClient(
    "https://project-ref.supabase.co",
    "legacy-service-role-test-key",
  );

  assert.equal(client.constructor.name, "PostgrestClient");
  assert.equal("realtime" in client, false);
  assert.equal(client.headers.get("apikey"), "legacy-service-role-test-key");
  assert.equal(
    client.headers.get("authorization"),
    "Bearer legacy-service-role-test-key",
  );
});

test("new secret keys are never sent as bearer tokens", () => {
  const client = createDatabaseClient(
    "https://project-ref.supabase.co",
    "sb_secret_test-key",
  );

  assert.equal(client.headers.get("apikey"), "sb_secret_test-key");
  assert.equal(client.headers.has("authorization"), false);
});
