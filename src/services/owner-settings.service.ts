import { BEHAVIOR_DEFAULTS } from "../config/behavior.js";
import { supportedTimeZone } from "../config/time-zones.js";
import { createHash, randomInt } from "node:crypto";
import type { DatabaseClient } from "../db/supabase.js";
import type { SessionIdentity } from "../utils/incoming-policy.js";
import { ownerIdentityField } from "../utils/incoming-policy.js";
import { HttpError } from "../utils/http-error.js";
import { normalizeIsraeliPhone, toChatId } from "../utils/whatsapp-id.js";

export interface OwnerSettings {
  translate_owner_answer?: boolean; behavior?: Record<string,unknown>; templates?: Record<string,Record<string,string>>;
  owner_phone: string | null; owner_chat_id: string | null;
  owner_pairing_hash?: string | null; owner_pairing_expires_at?: string | null;
  quiet_hours_start: string | null; quiet_hours_end: string | null;
  mode: string; time_zone?: string; auto_replies_paused: boolean;
  exceptions?: ScheduleException[];
}
export interface ScheduleException {
  id:string;start_date:string;end_date:string;kind:'day_off'|'special_hours';
  work_start:string|null;work_end:string|null;name:string;recurs_annually:boolean;
}
export async function loadOwnerSettings(db: DatabaseClient, tenantId: string): Promise<OwnerSettings> {
  const { data, error } = await db.from("notification_settings").select("owner_phone,owner_chat_id,owner_pairing_hash,owner_pairing_expires_at,quiet_hours_start,quiet_hours_end,mode,time_zone,auto_replies_paused,translate_owner_answer,behavior,templates").eq("tenant_id",tenantId).maybeSingle();
  if (error) throw new Error("Owner settings lookup failed");
  const exceptions=await db.from('schedule_exceptions').select('id,start_date,end_date,kind,work_start,work_end,name,recurs_annually').eq('tenant_id',tenantId).order('start_date');
  if(exceptions.error)throw new Error('Schedule exceptions lookup failed');
  return data ? {...data,exceptions:exceptions.data??[]} as unknown as OwnerSettings : { owner_phone:null,owner_chat_id:null,quiet_hours_start:null,quiet_hours_end:null,mode:"mute_all",time_zone:"Asia/Jerusalem",auto_replies_paused:false,exceptions:[] };
}
export function ownerDestination(settings: OwnerSettings): string { return settings.owner_chat_id || toChatId(settings.owner_phone); }
export function isBusinessOwner(from: string, settings: OwnerSettings): boolean {
  const canonical = (value: string) => value.replace(/@s\.whatsapp\.net$/, "@c.us");
  return !!settings.owner_phone && [toChatId(settings.owner_phone),settings.owner_chat_id].some(id => id && canonical(id) === canonical(from));
}
const hash = (code: string) => createHash("sha256").update(code).digest("hex");
// Numeric so the owner can just reply with digits from the WhatsApp message we send them,
// instead of typing a long hex command themselves (the earlier flow).
export const PAIRING_CODE_LENGTH = 6;
function generatePairingCode(): string {
  return String(randomInt(0, 10 ** PAIRING_CODE_LENGTH)).padStart(PAIRING_CODE_LENGTH, "0");
}
export interface SavedOwnerSettings { phone: string; code: string; ttlMinutes: number }
export async function saveOwnerSettings(db: DatabaseClient, tenantId: string, input: Record<string,unknown>, me: SessionIdentity): Promise<SavedOwnerSettings> {
  // Normalize before validating/storing — a local-format number (0523695741) must not
  // reach the database as-is: toChatId() would still resolve it correctly on every
  // read, but only after normalization is applied at least once. Validating here
  // instead of just accepting any 7-15 digit string catches the bug that shipped
  // silently: a locally-formatted number "saved" successfully but the confirmation
  // code went to a JID that does not exist on WhatsApp, with no error anywhere.
  const phone = normalizeIsraeliPhone(input.phone);
  if (!phone) throw new HttpError(400,"Укажите номер владельца в формате +972501234567 или 0501234567.");
  if (!me.id) throw new HttpError(409,"Сначала подключите бизнес-номер WhatsApp.");
  if (ownerIdentityField(toChatId(phone),me)) throw new HttpError(400,"Номер владельца должен отличаться от бизнес-номера WhatsApp.");
  const start = input.quietStart || null; const end = input.quietEnd || null;
  const validTime = (v: unknown) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
  if ((start || end) && (!validTime(start) || !validTime(end) || start === end)) throw new HttpError(400,"Укажите начало и окончание тихих часов.");
  const timeZone=typeof input.timeZone==='string'?input.timeZone:'';
  if(!supportedTimeZone(timeZone)) throw new HttpError(400,"Выберите часовой пояс владельца из списка.");
  const settings = await loadOwnerSettings(db,tenantId);
  const code = generatePairingCode();
  const ttlMinutes = Number(settings.behavior?.pairing_ttl_minutes ?? BEHAVIOR_DEFAULTS.pairing_ttl_minutes);
  const { error } = await db.from("notification_settings").upsert({tenant_id:tenantId,owner_phone:phone,owner_chat_id:null,
    time_zone:timeZone,owner_pairing_hash:hash(code),owner_pairing_expires_at:new Date(Date.now()+ttlMinutes*60*1000).toISOString(),quiet_hours_start:start,quiet_hours_end:end,mode:"mute_all"},{onConflict:"tenant_id"});
  if(error) throw new Error("Owner settings save failed");
  return { phone, code, ttlMinutes };
}
export async function pairOwner(db: DatabaseClient,tenantId:string,from:string,text:string,settings:OwnerSettings):Promise<boolean> {
  // No pairing in progress: never intercept the message, so ordinary customer traffic
  // (which may well contain a bare number) flows through untouched.
  if(!settings.owner_pairing_hash || !settings.owner_pairing_expires_at || Date.parse(settings.owner_pairing_expires_at)<=Date.now()) return false;
  const match = /^\D*(\d{6})\D*$/.exec(text.trim());
  if(!match) return false;
  if(hash(match[1]!)!==settings.owner_pairing_hash || (!from.endsWith("@lid") && !isBusinessOwner(from,settings))) return true;
  const {error}=await db.from("notification_settings").update({owner_chat_id:from,owner_pairing_hash:null,owner_pairing_expires_at:null})
    .eq("tenant_id",tenantId).eq("owner_pairing_hash",settings.owner_pairing_hash);
  if(error) throw new Error("Owner pairing failed");
  return true;
}
