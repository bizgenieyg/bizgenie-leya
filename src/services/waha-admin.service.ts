import { randomBytes } from "node:crypto";
import { decryptCredential, encryptCredential } from "../utils/crypto.js";
import { requireEnv } from "../config/env.js";
import { supabase, type DatabaseClient } from "../db/supabase.js";
import {
  createWhatsAppSessionProvider,
  type WhatsAppSessionProvider,
} from "../providers/whatsapp/index.js";
import type { QrImage, SessionStatus } from "../providers/whatsapp/whatsapp-provider.interface.js";
import { HttpError } from "../utils/http-error.js";
import {
  disconnectWahaSession,
  reconnectWahaSession,
  sessionConfigForTenant,
  sessionNameForTenant,
} from "./waha-admin.utils.js";

function upstreamError(): never {
  throw new HttpError(502, "WAHA request failed");
}

export class WahaAdminService {
  constructor(
    private readonly db: DatabaseClient = supabase,
    private readonly provider: WhatsAppSessionProvider = createWhatsAppSessionProvider(),
    private readonly publicBaseUrl: string = requireEnv("PUBLIC_BASE_URL"),
    private readonly wahaUrl: string = requireEnv("WAHA_URL"),
  ) {}

  async create(tenantId: string): Promise<{ session: string; status: string }> {
    await this.requireTenant(tenantId);
    const secret = await this.ensureWebhookSecret(tenantId);
    const config = sessionConfigForTenant(tenantId, this.publicBaseUrl, secret);
    let status: SessionStatus;
    try {
      status = await this.provider.startSession(config);
    } catch {
      upstreamError();
    }
    await this.updateInstanceStatus(tenantId, status.status);
    return { session: config.name, status: status.status };
  }

  async qr(tenantId: string): Promise<QrImage> {
    const session = await this.requireSession(tenantId);
    try {
      return await this.provider.getQrImage(session);
    } catch {
      let current: SessionStatus;
      try {
        current = await this.provider.getSessionStatus(session);
      } catch {
        upstreamError();
      }
      const known = ["FAILED", "STOPPED", "STARTING", "WORKING", "SCAN_QR_CODE"];
      const status = known.includes(current.status) ? current.status : "UNKNOWN";
      throw new HttpError(409, `WhatsApp QR unavailable: session status ${status}. Reconnect the session if FAILED or STOPPED.`);
    }
  }

  async status(tenantId: string): Promise<{ session: string; status: SessionStatus }> {
    const session = await this.requireSession(tenantId);
    let status: SessionStatus;
    try {
      status = await this.provider.getSessionStatus(session);
    } catch {
      upstreamError();
    }
    const { error } = await this.db
      .from("whatsapp_instances")
      .update({ status: status.status, last_health_check_at: new Date().toISOString() })
      .eq("tenant_id", tenantId);
    if (error) throw new HttpError(500, "Could not update WhatsApp status");
    return { session, status };
  }

  async reconnect(tenantId: string): Promise<{ session: string; status: string }> {
    const session = await this.requireSession(tenantId);
    const secret = await this.ensureWebhookSecret(tenantId);
    const config = sessionConfigForTenant(tenantId, this.publicBaseUrl, secret);
    if (session !== config.name) {
      throw new HttpError(409, "Stored WhatsApp session name is invalid for tenant");
    }
    let status: SessionStatus;
    try {
      status = await reconnectWahaSession(this.provider, config);
    } catch {
      upstreamError();
    }
    await this.updateInstanceStatus(tenantId, status.status);
    return { session, status: status.status };
  }

  async disconnect(tenantId: string): Promise<{ session: string; disconnected: true }> {
    const session = await this.requireSession(tenantId);
    try {
      await disconnectWahaSession(this.provider, session);
    } catch {
      upstreamError();
    }
    await this.updateInstanceStatus(tenantId, "disconnected");
    return { session, disconnected: true };
  }

  private async requireTenant(tenantId: string): Promise<void> {
    const { data, error } = await this.db
      .from("tenants")
      .select("id")
      .eq("id", tenantId)
      .maybeSingle();
    if (error) throw new HttpError(500, "Tenant lookup failed");
    if (!data) throw new HttpError(404, "Tenant not found");
  }

  private async requireSession(tenantId: string): Promise<string> {
    const { data, error } = await this.db
      .from("whatsapp_instances")
      .select("session_name")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error) throw new HttpError(500, "WhatsApp instance lookup failed");
    if (!data || typeof data.session_name !== "string" || data.session_name === "") {
      throw new HttpError(404, "WhatsApp session not found");
    }
    return data.session_name;
  }

  private async ensureWebhookSecret(tenantId: string): Promise<string> {
    const key = requireEnv("CREDENTIAL_ENCRYPTION_KEY");
    // Insert without overwriting an existing secret, including concurrent creates.
    const { error: insertError } = await this.db.from("whatsapp_instances").upsert({
      tenant_id: tenantId,
      waha_url: this.wahaUrl,
      session_name: sessionNameForTenant(tenantId),
      status: "STOPPED",
      webhook_secret_encrypted: encryptCredential(randomBytes(32).toString("base64url"), key),
    }, { onConflict: "tenant_id", ignoreDuplicates: true });
    if (insertError) throw new HttpError(500, "Could not prepare WhatsApp session");

    // Repair legacy rows with no secret; the conditional update avoids rotating
    // the secret if another request has already supplied it.
    const { error: updateError } = await this.db.from("whatsapp_instances")
      .update({ webhook_secret_encrypted: encryptCredential(randomBytes(32).toString("base64url"), key) })
      .eq("tenant_id", tenantId).is("webhook_secret_encrypted", null);
    if (updateError) throw new HttpError(500, "Could not prepare webhook authentication");

    const { data, error } = await this.db.from("whatsapp_instances")
      .select("webhook_secret_encrypted").eq("tenant_id", tenantId).single();
    if (error || !data?.webhook_secret_encrypted) {
      throw new HttpError(500, "Could not load webhook authentication");
    }
    return decryptCredential(data.webhook_secret_encrypted as string, key);
  }

  private async updateInstanceStatus(tenantId: string, status: string): Promise<void> {
    const { error } = await this.db
      .from("whatsapp_instances")
      .update({ status })
      .eq("tenant_id", tenantId);
    if (error) throw new HttpError(500, "Could not update WhatsApp session");
  }
}
