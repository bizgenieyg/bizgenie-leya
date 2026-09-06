import assert from "node:assert/strict";
import test from "node:test";
import type { DatabaseClient } from "../db/supabase.js";
import type { WhatsAppSessionProvider, StartSessionInput } from "../providers/whatsapp/whatsapp-provider.interface.js";
import { decryptCredential } from "../utils/crypto.js";
import { HttpError } from "../utils/http-error.js";

process.env.SUPABASE_URL = "https://database.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";
process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

test("create persists the matching encrypted secret before WAHA starts; reconnect repairs legacy rows", async () => {
  const { WahaAdminService } = await import("./waha-admin.service.js");
  const tenantId = "123e4567-e89b-42d3-a456-426614174000";
  let row: Record<string, unknown> | undefined;
  let failWrites = false;
  const db = {
    from(table: string) {
      let patch: Record<string, unknown> | undefined;
      let onlyNull = false;
      const query = {
        select() { return query; },
        eq(column: string, value: string) {
          assert.equal(value, tenantId);
          assert.ok(column === "id" || column === "tenant_id");
          return query;
        },
        is(column: string, value: null) {
          assert.equal(column, "webhook_secret_encrypted");
          assert.equal(value, null);
          onlyNull = true; return query;
        },
        update(values: Record<string, unknown>) { patch = values; return query; },
        async upsert(values: Record<string, unknown>, options: { ignoreDuplicates: boolean }) {
          assert.equal(options.ignoreDuplicates, true);
          if (!failWrites) row ??= { ...values };
          return { error: failWrites ? {} : null };
        },
        async maybeSingle() { return { data: table === "tenants" ? { id: tenantId } : row, error: null }; },
        async single() { return { data: row, error: null }; },
        then(resolve: (value: unknown) => unknown) {
          if (patch && row && (!onlyNull || row.webhook_secret_encrypted == null)) Object.assign(row, patch);
          return Promise.resolve(resolve({ error: null }));
        },
      };
      return query;
    },
  } as unknown as DatabaseClient;
  let starts = 0;
  function verifyConfig(input: StartSessionInput) {
    starts++;
    const secret = decryptCredential(String(row?.webhook_secret_encrypted), process.env.CREDENTIAL_ENCRYPTION_KEY!);
    assert.equal(input.config.webhooks[0]?.customHeaders[0]?.value, secret);
    assert.equal(input.config.markOnline, false);
    return Promise.resolve({ status: "STARTING" });
  }
  const provider: WhatsAppSessionProvider = {
    startSession: verifyConfig,
    restartSession: verifyConfig,
    stopSession: async () => {},
    logoutSession: async () => {},
    deleteSession: async () => {},
    getSessionStatus: async () => ({ status: "FAILED" }),
    getQrImage: async () => { throw new Error("sensitive upstream 422"); },
  };
  const service = new WahaAdminService(db, provider, "https://leia.example.com", "http://waha.internal");
  await service.create(tenantId);
  const firstSecret = row?.webhook_secret_encrypted;
  await service.reconnect(tenantId);
  assert.equal(row?.webhook_secret_encrypted, firstSecret);
  row!.webhook_secret_encrypted = null;
  await service.reconnect(tenantId);
  assert.ok(row?.webhook_secret_encrypted);
  await assert.rejects(service.qr(tenantId), (error: unknown) =>
    error instanceof HttpError && error.status === 409 && error.message.includes("FAILED") && !error.message.includes("sensitive"));
  failWrites = true;
  await assert.rejects(service.create(tenantId), /Could not prepare/);
  assert.equal(starts, 3);
});
