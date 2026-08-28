import type { SupabaseClient } from "@supabase/supabase-js";

import { HttpError } from "../utils/http-error.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TenantRow {
  id: string;
  name: string;
  phone: string;
  status: string;
  language: string | null;
}

export interface WhatsappInstanceRow {
  id: string;
  tenant_id: string;
  session_name: string | null;
  phone: string | null;
  status: string | null;
  webhook_secret_encrypted: string | null;
  waha_api_key_encrypted: string | null;
}

export interface TenantRouting {
  tenant: TenantRow;
  instance: WhatsappInstanceRow | null;
}

export interface ClientRow {
  id: string;
  tenant_id: string;
  phone: string;
  name: string | null;
}

export interface ConversationRow {
  id: string;
  tenant_id: string;
  client_id: string;
  status: string;
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Load the tenant addressed by a webhook route plus its WhatsApp instance (if any). */
export async function getTenantRouting(
  db: SupabaseClient,
  tenantId: string,
): Promise<TenantRouting | null> {
  if (!isUuid(tenantId)) {
    return null;
  }

  const { data: tenant, error: tenantError } = await db
    .from("tenants")
    .select("id, name, phone, status, language")
    .eq("id", tenantId)
    .maybeSingle();
  if (tenantError) {
    throw new HttpError(500, "Tenant lookup failed");
  }
  if (!tenant) {
    return null;
  }

  const { data: instance, error: instanceError } = await db
    .from("whatsapp_instances")
    .select(
      "id, tenant_id, session_name, phone, status, webhook_secret_encrypted, waha_api_key_encrypted",
    )
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (instanceError) {
    throw new HttpError(500, "WhatsApp instance lookup failed");
  }

  return {
    tenant: tenant as TenantRow,
    instance: (instance as WhatsappInstanceRow | null) ?? null,
  };
}

export function isTenantServiceable(status: string): boolean {
  return status === "trial" || status === "active";
}

/** Find a client by (tenant, phone) or create one. Also refreshes `last_seen_at`. */
export async function findOrCreateClient(
  db: SupabaseClient,
  tenantId: string,
  phone: string,
  name: string | null,
): Promise<ClientRow> {
  const nowIso = new Date().toISOString();

  const { data: existing, error: findError } = await db
    .from("clients")
    .select("id, tenant_id, phone, name")
    .eq("tenant_id", tenantId)
    .eq("phone", phone)
    .maybeSingle();
  if (findError) {
    throw new HttpError(500, "Client lookup failed");
  }

  if (existing) {
    const patch: Record<string, unknown> = { last_seen_at: nowIso };
    if (name && !existing.name) {
      patch.name = name;
    }
    await db.from("clients").update(patch).eq("id", existing.id);
    return {
      id: existing.id as string,
      tenant_id: existing.tenant_id as string,
      phone: existing.phone as string,
      name: (name && !existing.name ? name : (existing.name as string | null)) ?? null,
    };
  }

  const { data: created, error: createError } = await db
    .from("clients")
    .insert({
      tenant_id: tenantId,
      phone,
      name,
      first_seen_at: nowIso,
      last_seen_at: nowIso,
    })
    .select("id, tenant_id, phone, name")
    .single();
  if (createError || !created) {
    throw new HttpError(500, "Could not create client");
  }
  return created as ClientRow;
}

/** Find the tenant/client's active conversation or open a new one. */
export async function findOrCreateConversation(
  db: SupabaseClient,
  tenantId: string,
  clientId: string,
): Promise<ConversationRow> {
  const nowIso = new Date().toISOString();

  const { data: existing, error: findError } = await db
    .from("conversations")
    .select("id, tenant_id, client_id, status")
    .eq("tenant_id", tenantId)
    .eq("client_id", clientId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1);
  if (findError) {
    throw new HttpError(500, "Conversation lookup failed");
  }

  const current = existing?.[0];
  if (current) {
    await db
      .from("conversations")
      .update({ last_message_at: nowIso })
      .eq("id", current.id);
    return current as ConversationRow;
  }

  const { data: created, error: createError } = await db
    .from("conversations")
    .insert({
      tenant_id: tenantId,
      client_id: clientId,
      status: "active",
      last_message_at: nowIso,
    })
    .select("id, tenant_id, client_id, status")
    .single();
  if (createError || !created) {
    throw new HttpError(500, "Could not create conversation");
  }
  return created as ConversationRow;
}
