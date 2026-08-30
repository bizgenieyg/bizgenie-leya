import assert from "node:assert/strict";
import test from "node:test";

import type {
  QrImage,
  SessionStatus,
  StartSessionInput,
  WhatsAppSessionProvider,
} from "../providers/whatsapp/whatsapp-provider.interface.js";
import {
  disconnectWahaSession,
  reconnectWahaSession,
  sessionConfigForTenant,
} from "./waha-admin.utils.js";

const TENANT_ID = "123e4567-e89b-42d3-a456-426614174000";

class FakeSessionProvider implements WhatsAppSessionProvider {
  readonly calls: string[] = [];

  async startSession(input: StartSessionInput): Promise<SessionStatus> {
    this.calls.push(`start:${input.name}`);
    return { status: "STARTING" };
  }

  async stopSession(session: string): Promise<void> {
    this.calls.push(`stop:${session}`);
  }

  async logoutSession(session: string): Promise<void> {
    this.calls.push(`logout:${session}`);
  }

  async deleteSession(session: string): Promise<void> {
    this.calls.push(`delete:${session}`);
  }

  async getSessionStatus(_session: string): Promise<SessionStatus> {
    return { status: "WORKING" };
  }

  async getQrImage(_session: string): Promise<QrImage> {
    return { data: Buffer.alloc(0), contentType: "image/png" };
  }
}

test("builds one deterministic shared-container session config per tenant", () => {
  assert.deepEqual(
    sessionConfigForTenant(TENANT_ID, "https://leia.example.com/"),
    {
      name: `tenant-${TENANT_ID}`,
      config: {
        webhooks: [
          {
            url: `https://leia.example.com/webhook/${TENANT_ID}`,
            events: ["message", "session.status"],
          },
        ],
        metadata: { tenant_id: TENANT_ID },
      },
    },
  );
});

test("reconnect stops then starts without logout", async () => {
  const provider = new FakeSessionProvider();
  const config = sessionConfigForTenant(TENANT_ID, "https://leia.example.com");
  await reconnectWahaSession(provider, config);
  assert.deepEqual(provider.calls, [
    `stop:tenant-${TENANT_ID}`,
    `start:tenant-${TENANT_ID}`,
  ]);
});

test("disconnect logs out, stops, then deletes in strict order", async () => {
  const provider = new FakeSessionProvider();
  await disconnectWahaSession(provider, `tenant-${TENANT_ID}`);
  assert.deepEqual(provider.calls, [
    `logout:tenant-${TENANT_ID}`,
    `stop:tenant-${TENANT_ID}`,
    `delete:tenant-${TENANT_ID}`,
  ]);
});
