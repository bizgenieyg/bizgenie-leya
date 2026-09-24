import { SessionNotFoundError } from "../providers/whatsapp/whatsapp-provider.interface.js";
import { randomBytes } from "node:crypto";
import { decryptCredential, encryptCredential } from "../utils/crypto.js";
import { requireEnv } from "../config/env.js";
import { supabase, type DatabaseClient } from "../db/supabase.js";
import {
  createWhatsAppSessionProvider,
  type WhatsAppSessionProvider,
} from "../providers/whatsapp/index.js";
import type { QrImage, SessionStatus, WhatsAppChatActivity, WhatsAppGroup } from "../providers/whatsapp/whatsapp-provider.interface.js";
import { HttpError } from "../utils/http-error.js";
import { invalidateTenantRouting } from './tenant.service.js';
import { invalidateSessionIdentity } from './session-identity.service.js';
import { canonicalIdentity, readSessionIdentity } from "../utils/incoming-policy.js";
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
  private readonly groupsCache = new Map<string, { expiresAt: number; value: WhatsAppGroup[] }>();
  private readonly summarySeeded = new Set<string>();
  constructor(
    private readonly db: DatabaseClient = supabase,
    private readonly provider: WhatsAppSessionProvider = createWhatsAppSessionProvider(),
    private readonly publicBaseUrl: string = requireEnv("PUBLIC_BASE_URL"),
    private readonly wahaUrl: string = requireEnv("WAHA_URL"),
  ) {}

  async create(tenantId: string) {
    await this.requireTenant(tenantId);
    const session = sessionNameForTenant(tenantId);
    let existing = await this.readStatus(session);
    if (existing.status !== "NOT_CREATED") {
      await this.ensureWebhookSecret(tenantId);
      await this.updateInstanceStatus(tenantId, existing.status);
      return { session, ...existing, created: false };
    }
    const secret = await this.ensureWebhookSecret(tenantId);
    const config = sessionConfigForTenant(tenantId, this.publicBaseUrl, secret);
    let status: SessionStatus;
    try {
      status = await this.provider.startSession(config);
    } catch {
      // A competing create may have won after our initial lookup.
      existing = await this.readStatus(session);
      if (existing.status !== "NOT_CREATED") {
        await this.updateInstanceStatus(tenantId, existing.status);
        return { session, ...existing, created: false };
      }
      upstreamError();
    }
    const normalized = normalizeSessionStatus(status);
    await this.updateInstanceStatus(tenantId, normalized.status);
    invalidateSessionIdentity(session);
    return { session, ...normalized, created: true };
  }

  async qr(tenantId: string): Promise<QrImage> {
    await this.requireTenant(tenantId);
    const session = sessionNameForTenant(tenantId);
    const current = await this.readStatus(session);
    if (!current.qrAvailable) {
      throw new HttpError(409, "QR is unavailable in the current session state", current);
    }
    try {
      return await this.provider.getQrImage(session);
    } catch {
      // The session may transition between status lookup and QR retrieval.
      const latest = await this.readStatus(session);
      if (!latest.qrAvailable) {
        throw new HttpError(409, "QR is unavailable in the current session state", latest);
      }
      upstreamError();
    }
  }

  async status(tenantId: string) {
    await this.requireTenant(tenantId);
    const session = sessionNameForTenant(tenantId);
    let raw: SessionStatus | undefined;
    let status: { status: string; qrAvailable: boolean; reason?: string };
    try {
      raw = await this.provider.getSessionStatus(session);
      status = normalizeSessionStatus(raw);
    } catch (error) {
      if (!(error instanceof SessionNotFoundError)) upstreamError();
      status = { status: "NOT_CREATED", qrAvailable: false };
    }
    await this.updateInstanceStatus(tenantId, status.status);
    if (status.status !== "WORKING") return { session, ...status };
    const numberChanged = await this.checkNumberChange(tenantId, raw?.me);
    return { session, ...status, ...(numberChanged ? { numberChanged: true } : {}) };
  }

  private async readStatus(session: string): Promise<{ status: string; qrAvailable: boolean; reason?: string }> {
    try {
      return normalizeSessionStatus(await this.provider.getSessionStatus(session));
    } catch (error) {
      if (error instanceof SessionNotFoundError) return { status: "NOT_CREATED", qrAvailable: false };
      upstreamError();
    }
  }

  /**
   * Compares the just-connected WhatsApp account against the last one this tenant
   * acknowledged (see `acknowledgeNumberChange`). Never overwrites an existing
   * `connected_identity` here — only `acknowledgeNumberChange` does — so a detected
   * mismatch survives a page reload until the owner actually answers the "clear old
   * data?" prompt. A first-ever connection has nothing to compare against, so it is
   * recorded immediately instead of asked about.
   */
  private async checkNumberChange(tenantId: string, me: SessionStatus["me"]): Promise<boolean> {
    const identity = canonicalIdentity(readSessionIdentity(me));
    if (!identity) return false;
    const { data, error } = await this.db.from("whatsapp_instances")
      .select("connected_identity").eq("tenant_id", tenantId).maybeSingle();
    if (error) throw new HttpError(500, "WhatsApp instance lookup failed");
    const previous = (data as { connected_identity?: string | null } | null)?.connected_identity ?? null;
    if (!previous) {
      await this.recordConnectedIdentity(tenantId, identity);
      return false;
    }
    return previous !== identity;
  }

  private async recordConnectedIdentity(tenantId: string, identity: string): Promise<void> {
    const { error } = await this.db.from("whatsapp_instances")
      .update({ connected_identity: identity }).eq("tenant_id", tenantId);
    if (error) throw new HttpError(500, "Could not update WhatsApp session");
  }

  /**
   * Called once the owner has answered the "different number, clear old data?"
   * prompt (either way) so the same swap is not asked about again. Re-reads the
   * session itself rather than trusting a client-supplied identity.
   */
  async acknowledgeNumberChange(tenantId: string): Promise<void> {
    const identity = await this.connectedIdentity(tenantId);
    await this.recordConnectedIdentity(tenantId, identity);
  }

  async requirePendingNumberChange(tenantId: string): Promise<void> {
    const identity = await this.connectedIdentity(tenantId);
    const { data, error } = await this.db.from("whatsapp_instances")
      .select("connected_identity").eq("tenant_id", tenantId).maybeSingle();
    if (error) throw new HttpError(500, "WhatsApp instance lookup failed");
    const stored = (data as { connected_identity?: string | null } | null)?.connected_identity;
    const acknowledged = canonicalIdentity(stored ? { id: stored } : {});
    if (!acknowledged || acknowledged === identity) {
      throw new HttpError(409, "No pending WhatsApp number change");
    }
  }

  private async connectedIdentity(tenantId: string): Promise<string> {
    const session = await this.requireSession(tenantId);
    let raw: SessionStatus;
    try {
      raw = await this.provider.getSessionStatus(session);
    } catch {
      throw new HttpError(409, "WhatsApp session is not connected");
    }
    const identity = canonicalIdentity(readSessionIdentity(raw.me));
    if (normalizeSessionStatus(raw).status !== "WORKING" || !identity) {
      throw new HttpError(409, "WhatsApp session is not connected");
    }
    return identity;
  }

  async reconnect(tenantId: string): Promise<{ session: string; status: string; qrAvailable: boolean; numberChanged?: boolean }> {
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
    invalidateSessionIdentity(session);
    const normalized = normalizeSessionStatus(status);
    if (normalized.status !== "WORKING") return { session, ...normalized };
    const numberChanged = await this.checkNumberChange(tenantId, status.me);
    return { session, ...normalized, ...(numberChanged ? { numberChanged: true } : {}) };
  }

  async disconnect(tenantId: string): Promise<{ session: string; disconnected: true }> {
    const session = await this.requireSession(tenantId);
    try {
      await disconnectWahaSession(this.provider, session);
    } catch {
      upstreamError();
    }
    await this.updateInstanceStatus(tenantId, "disconnected");
    invalidateSessionIdentity(session);
    return { session, disconnected: true };
  }

  async groups(tenantId: string) {
    const session = await this.requireSession(tenantId);
    const cached = this.groupsCache.get(session);
    if (cached && cached.expiresAt > Date.now()) return { groups: cached.value };
    try {
      if (!this.provider.getGroups) upstreamError();
      const groups = await this.provider.getGroups(session);
      const baseGroups = groups.map(({ lastActivityAt: _ignored, ...group }) => group);
      let result = sortGroups(baseGroups);
      if (this.provider.getChats) {
        try {
          const chats: WhatsAppChatActivity[] = [];
          for (let offset = 0; offset < 2000; offset += 200) {
            const page = await this.provider.getChats(session, { limit: 200, offset, sortBy: "conversationTimestamp", sortOrder: "desc" });
            if (!Array.isArray(page)) throw new Error("WAHA chats endpoint returned a non-array response");
            if (page.length === 0) break;
            chats.push(...page.slice(0, 2000 - chats.length));
          }
          result = groupsWithActivity(baseGroups, chats);
        } catch {
          // Chat metadata is optional; keep the group directory available.
        }
      }
      this.groupsCache.set(session, { expiresAt: Date.now() + 120_000, value: result });
      return { groups: result };
    } catch {
      upstreamError();
    }
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
    invalidateTenantRouting(this.db,tenantId);
    return decryptCredential(data.webhook_secret_encrypted as string, key);
  }

  private async updateInstanceStatus(tenantId: string, status: string): Promise<void> {
    const { error } = await this.db
      .from("whatsapp_instances")
      .update({ status })
      .eq("tenant_id", tenantId);
    if (error) throw new HttpError(500, "Could not update WhatsApp session");
    if(status === 'WORKING' && !this.summarySeeded.has(tenantId)){
      try{
        const {loadOwnerSettings}=await import('./owner-settings.service.js');
        const {ensureOwnerSummaryJob}=await import('./owner-summary.service.js');
        await ensureOwnerSummaryJob(this.db,tenantId,await loadOwnerSettings(this.db,tenantId));
        this.summarySeeded.add(tenantId);
      }catch{console.error('owner_summary_seed_failed',{tenantId});}
    }
  }
}

function sortGroups(groups: WhatsAppGroup[]): WhatsAppGroup[] {
  return [...groups].sort((a, b) => {
    const timeOrder = (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "");
    return timeOrder || a.name.localeCompare(b.name);
  });
}

export function groupsWithActivity(groups: WhatsAppGroup[], chats: WhatsAppChatActivity[]): WhatsAppGroup[] {
  const timestamps = new Map(chats.flatMap(chat => chat.conversationTimestamp
    ? [[chat.id, chat.conversationTimestamp] as const] : []));
  return sortGroups(groups.map(group => {
    const timestamp = timestamps.get(group.id);
    if (!timestamp) return group;
    const date = new Date(timestamp * 1000);
    return Number.isFinite(date.getTime()) ? { ...group, lastActivityAt: date.toISOString() } : group;
  }));
}

export function normalizeSessionStatus(value: SessionStatus) {
  const raw = value.status.trim();
  const known = ["STOPPED", "STARTING", "SCAN_QR_CODE", "WORKING", "FAILED"];
  const status = known.includes(raw.toUpperCase()) ? raw.toUpperCase() : raw || "UNKNOWN";
  return { status, qrAvailable: status === "SCAN_QR_CODE",
    ...(status === "FAILED" && value.reason ? { reason: value.reason } : {}) };
}
