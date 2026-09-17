import type { DatabaseClient } from "../db/supabase.js";

import { HttpError } from "../utils/http-error.js";
import { isGroupChatJid } from "../utils/incoming-policy.js";
import { stripJidSuffix } from "../utils/whatsapp-id.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TenantRow {
  id: string;
  name: string;
  phone: string | null;
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
}

export interface TenantRouting {
  tenant: TenantRow;
  instance: WhatsappInstanceRow | null;
}

export interface ClientRow {
  time_zone?: string | null;
  id: string;
  tenant_id: string;
  phone: string;
  whatsapp_jid?:string;
  name: string | null;
  language?:string|null;language_overridden?:boolean;auto_reply_allowed?:boolean;
  chat_type?:'individual'|'group';
}

export interface ConversationRow {
  id: string;
  tenant_id: string;
  client_id: string;
  status: string;
  last_message_at?:string|null;source_label?:string|null;routed_agent?:string|null;route_selected_at?:string|null;reception_message_count?:number;
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Load the tenant addressed by a webhook route plus its WhatsApp instance (if any). */
export async function getTenantRouting(
  db: DatabaseClient,
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
      "id, tenant_id, session_name, phone, status, webhook_secret_encrypted",
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
  db: DatabaseClient,
  tenantId: string,
  phone: string,
  name: string | null,
  whatsappJid=phone,
): Promise<ClientRow> {
  const nowIso = new Date().toISOString();

  const columns="id, tenant_id, phone, whatsapp_jid, name, time_zone,language,language_overridden,auto_reply_allowed,chat_type,deleted_at";
  const { data: exact, error: findError } = await db
    .from("clients")
    .select(columns)
    .eq("tenant_id", tenantId)
    .eq("whatsapp_jid", whatsappJid)
    .maybeSingle();
  if (findError) {
    throw new HttpError(500, "Client lookup failed");
  }
  let existing=exact;
  const contactKey=stripJidSuffix(whatsappJid),normalizedName=name?.trim().toLocaleLowerCase()??'';
  if(!existing&&contactKey&&normalizedName){
    const aliases=[contactKey,`${contactKey}@lid`];
    const fallback=await db.from("clients").select(columns).eq("tenant_id",tenantId).in("phone",aliases).limit(5);
    if(fallback.error)throw new HttpError(500,"Client lookup failed");
    existing=(fallback.data??[]).find(row=>stripJidSuffix(String(row.whatsapp_jid??row.phone))===contactKey&&String(row.name??'').trim().toLocaleLowerCase()===normalizedName)??null;
  }

  if (existing) {
    const patch: Record<string, unknown> = { last_seen_at: nowIso,deleted_at:null,chat_type:isGroupChatJid(whatsappJid)?'group':'individual' };
    if (name && name !== existing.name) {
      patch.name = name;
    }
    await db.from("clients").update(patch).eq("id", existing.id);
    return {
      id: existing.id as string,
      tenant_id: existing.tenant_id as string,
      phone: existing.phone as string,
      whatsapp_jid:existing.whatsapp_jid as string,
      time_zone: existing.time_zone as string | null,
      name: name ?? (existing.name as string | null) ?? null,
      language:existing.language as string|null,language_overridden:existing.language_overridden===true,auto_reply_allowed:existing.auto_reply_allowed!==false,
      chat_type:isGroupChatJid(whatsappJid)?'group':'individual',
    };
  }

  const { data: created, error: createError } = await db
    .from("clients")
    .insert({
      tenant_id: tenantId,
      phone,
      whatsapp_jid:whatsappJid,
      chat_type:isGroupChatJid(whatsappJid)?'group':'individual',
      name,
      first_seen_at: nowIso,
      last_seen_at: nowIso,
    })
    .select("id, tenant_id, phone, whatsapp_jid, name, time_zone,language,language_overridden,auto_reply_allowed,chat_type")
    .single();
  if (createError || !created) {
    throw new HttpError(500, "Could not create client");
  }
  return created as ClientRow;
}

/** Find the tenant/client's active conversation or open a new one. */
export async function findOrCreateConversation(
  db: DatabaseClient,
  tenantId: string,
  clientId: string,
): Promise<ConversationRow> {
  const nowIso = new Date().toISOString();

  const { data: existing, error: findError } = await db
    .from("conversations")
    .select("id, tenant_id, client_id, status,last_message_at,source_label,routed_agent,route_selected_at,reception_message_count")
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
    .select("id, tenant_id, client_id, status,last_message_at,source_label,routed_agent,route_selected_at,reception_message_count")
    .single();
  if (createError || !created) {
    throw new HttpError(500, "Could not create conversation");
  }
  return created as ConversationRow;
}
