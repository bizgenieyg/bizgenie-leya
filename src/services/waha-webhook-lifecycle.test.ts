import assert from "node:assert/strict";
import test from "node:test";
import type { DatabaseClient } from "../db/supabase.js";
// Deliberately kept on a hand-rolled DatabaseClient mock, not PGlite (see review that
// moved context.service/conversation-routing/owner-workflow/webhook-worker/
// message-retention to PGlite): this file's assertions are about WAHA provider error
// branches and session lifecycle, not about database schema/types/constraints. A mock
// is the right tool here. Do not convert without a concrete reason.
import { SessionNotFoundError } from "../providers/whatsapp/whatsapp-provider.interface.js";
import type { WhatsAppSessionProvider, StartSessionInput } from "../providers/whatsapp/whatsapp-provider.interface.js";
import { decryptCredential, encryptCredential } from "../utils/crypto.js";
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
          if (column === 'last_session_alert') return query;
          if (column === 'status') assert.equal(value, row?.status);
          else { assert.equal(value, tenantId); assert.ok(column === "id" || column === "tenant_id"); }
          return query;
        },
        is(column: string, value: null) {
          if (column === 'last_session_alert') return query;
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
        async maybeSingle() { if (patch && row) Object.assign(row, patch); return { data: table === "tenants" ? { id: tenantId } : row, error: null }; },
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
    getSessionStatus: async () => { if (!starts) throw new SessionNotFoundError(); return { status: "FAILED" }; },
    getQrImage: async () => { throw new Error("sensitive upstream 422"); },
  };
  const service = new WahaAdminService(db, provider, "https://leya.example.com", "http://waha.internal");
  await service.create(tenantId);
  const firstSecret = row?.webhook_secret_encrypted;
  await service.reconnect(tenantId);
  assert.equal(row?.webhook_secret_encrypted, firstSecret);
  row!.webhook_secret_encrypted = null;
  await service.reconnect(tenantId);
  assert.ok(row?.webhook_secret_encrypted);
  await assert.rejects(service.qr(tenantId), (error: unknown) =>
    error instanceof HttpError && error.status === 409 && error.details?.status === "FAILED" && !error.message.includes("sensitive"));
  for (const status of ["STOPPED", "STARTING", "SCAN_QR_CODE", "WORKING", "FAILED", "FUTURE_STATE"]) {
    provider.getSessionStatus = async () => ({ status });
    const existing = await service.create(tenantId);
    assert.equal(existing.created, false);
    assert.equal(existing.status, status);
    assert.equal(existing.qrAvailable, status === "SCAN_QR_CODE");
    assert.equal(starts, 3);
    if (status !== "SCAN_QR_CODE") await assert.rejects(service.qr(tenantId), (error: unknown) => error instanceof HttpError && error.status === 409 && error.details?.status === status);
  }
  provider.getSessionStatus = async () => { throw new SessionNotFoundError(); };
  assert.deepEqual(await service.status(tenantId), {
    session: `tenant-${tenantId}`, status: "NOT_CREATED", qrAvailable: false,
  });
  let statusReads = 0;
  provider.getSessionStatus = async () => {
    if (++statusReads === 1) throw new SessionNotFoundError();
    return { status: "STARTING" };
  };
  provider.startSession = async () => { throw new Error("concurrent create conflict"); };
  const raced = await service.create(tenantId);
  assert.equal(raced.created, false);
  assert.equal(raced.status, "STARTING");
  assert.equal(statusReads, 2);

  // QR may transition out of SCAN_QR_CODE while the image request is in flight.
  statusReads = 0;
  provider.getSessionStatus = async () => ({ status: ++statusReads === 1 ? "SCAN_QR_CODE" : "FAILED" });
  await assert.rejects(service.qr(tenantId), (error: unknown) =>
    error instanceof HttpError && error.status === 409 && error.details?.status === "FAILED");
  provider.getSessionStatus = async () => ({ status: "SCAN_QR_CODE" });
  provider.getQrImage = async () => ({ data: Buffer.from([137, 80, 78, 71]), contentType: "image/png" });
  assert.equal((await service.qr(tenantId)).contentType, "image/png");
  failWrites = true;
  await assert.rejects(service.create(tenantId), /Could not prepare/);
  assert.equal(starts, 3);
});

// A single whatsapp_instances row per tenant, exercised through the same generic
// query-builder shape as the mock above (a `.then()` on the query object stands in for
// an update without a following `.select()`), but scoped to one row per call instead
// of a shared closure variable, since these tests run several independent scenarios.
function makeInstanceDb(tenantId: string) {
  const row: Record<string, unknown> = {
    tenant_id: tenantId,
    session_name: `tenant-${tenantId}`,
    webhook_secret_encrypted: encryptCredential("seed-secret", process.env.CREDENTIAL_ENCRYPTION_KEY!),
  };
  const db = {
    from(table: string) {
      let patch: Record<string, unknown> | undefined;
      let onlyNull = false;
      const query = {
        select() { return query; },
        eq(column: string, value: string) {
          if (column === 'status') assert.equal(value, row.status);
          else { assert.equal(value, tenantId); assert.ok(column === "id" || column === "tenant_id"); }
          return query;
        },
        is(column: string, value: null) {
          if (column === 'last_session_alert') return query;
          assert.equal(column, "webhook_secret_encrypted");
          assert.equal(value, null);
          onlyNull = true; return query;
        },
        update(values: Record<string, unknown>) { patch = values; return query; },
        async upsert(values: Record<string, unknown>) {
          if (table === "whatsapp_instances") Object.assign(row, values);
          return { error: null };
        },
        async maybeSingle() { if (patch) Object.assign(row, patch); return { data: table === "tenants" ? { id: tenantId } : { ...row }, error: null }; },
        async single() { return { data: { ...row }, error: null }; },
        then(resolve: (value: unknown) => unknown) {
          if (patch && (!onlyNull || row.webhook_secret_encrypted == null)) Object.assign(row, patch);
          return Promise.resolve(resolve({ error: null }));
        },
      };
      return query;
    },
  } as unknown as DatabaseClient;
  return { db, row };
}

test("status() detects a WhatsApp number swap and defers recording it until acknowledged", async () => {
  const { WahaAdminService } = await import("./waha-admin.service.js");
  const tenantId = "223e4567-e89b-42d3-a456-426614174001";
  const { db, row } = makeInstanceDb(tenantId);
  let me: { id?: string } = { id: "972500000001@c.us" };
  const provider: WhatsAppSessionProvider = {
    startSession: async () => ({ status: "STARTING" }),
    restartSession: async () => ({ status: "STARTING" }),
    stopSession: async () => {}, logoutSession: async () => {}, deleteSession: async () => {},
    getSessionStatus: async () => ({ status: "WORKING", me }),
    getQrImage: async () => ({ data: Buffer.alloc(0), contentType: "image/png" }),
  };
  const service = new WahaAdminService(db, provider, "https://leya.example.com", "http://waha.internal");

  // First-ever connection: nothing to compare against, recorded immediately, no prompt.
  const first = await service.status(tenantId);
  assert.equal(first.numberChanged, undefined);
  assert.equal(row.connected_identity, "972500000001@c.us");

  // Same account reconnecting: still no prompt.
  const second = await service.status(tenantId);
  assert.equal(second.numberChanged, undefined);
  await assert.rejects(service.requirePendingNumberChange(tenantId),
    (error: unknown) => error instanceof HttpError && error.status === 409);

  // A different account connects — this is the number swap the cabinet must ask about.
  me = { id: "972500000002@c.us" };
  const third = await service.status(tenantId);
  assert.equal(third.numberChanged, true);
  // Not recorded yet: a page reload before the owner answers must ask again, not
  // silently forget the swap happened.
  assert.equal(row.connected_identity, "972500000001@c.us");
  const fourth = await service.status(tenantId);
  assert.equal(fourth.numberChanged, true);
  await service.requirePendingNumberChange(tenantId);

  // The owner answers (reset or not) and the cabinet acknowledges the swap.
  await service.acknowledgeNumberChange(tenantId);
  assert.equal(row.connected_identity, "972500000002@c.us");
  await assert.rejects(service.requirePendingNumberChange(tenantId),
    (error: unknown) => error instanceof HttpError && error.status === 409);
  const fifth = await service.status(tenantId);
  assert.equal(fifth.numberChanged, undefined);
});

test("acknowledgeNumberChange rejects when the session is not currently connected", async () => {
  const { WahaAdminService } = await import("./waha-admin.service.js");
  const tenantId = "323e4567-e89b-42d3-a456-426614174002";
  const { db } = makeInstanceDb(tenantId);
  const provider: WhatsAppSessionProvider = {
    startSession: async () => ({ status: "STARTING" }), restartSession: async () => ({ status: "STARTING" }),
    stopSession: async () => {}, logoutSession: async () => {}, deleteSession: async () => {},
    getSessionStatus: async () => ({ status: "SCAN_QR_CODE" }),
    getQrImage: async () => ({ data: Buffer.alloc(0), contentType: "image/png" }),
  };
  const service = new WahaAdminService(db, provider, "https://leya.example.com", "http://waha.internal");
  await assert.rejects(service.acknowledgeNumberChange(tenantId),
    (error: unknown) => error instanceof HttpError && error.status === 409);
});

test("reconnect() also flags a number swap when the retried session comes back WORKING", async () => {
  const { WahaAdminService } = await import("./waha-admin.service.js");
  const tenantId = "423e4567-e89b-42d3-a456-426614174003";
  const { db, row } = makeInstanceDb(tenantId);
  row.connected_identity = "972500000001@c.us";
  const newAccount = { status: "WORKING", me: { id: "972500000009@c.us" } };
  const provider: WhatsAppSessionProvider = {
    startSession: async () => newAccount, restartSession: async () => newAccount,
    stopSession: async () => {}, logoutSession: async () => {}, deleteSession: async () => {},
    getSessionStatus: async () => newAccount,
    getQrImage: async () => ({ data: Buffer.alloc(0), contentType: "image/png" }),
  };
  const service = new WahaAdminService(db, provider, "https://leya.example.com", "http://waha.internal");
  const result = await service.reconnect(tenantId);
  assert.equal(result.status, "WORKING");
  assert.equal(result.numberChanged, true);
  // Deferred here too, for the same reason as status().
  assert.equal(row.connected_identity, "972500000001@c.us");
});
