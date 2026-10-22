import { BEHAVIOR_DEFAULTS } from "../config/behavior.js";
import { DEFAULT_TIME_ZONE, supportedTimeZone } from "../config/time-zones.js";
import { createHash, randomInt } from "node:crypto";
import type { DatabaseClient } from "../db/supabase.js";
import type { SessionIdentity } from "../utils/incoming-policy.js";
import { ownerIdentityField, readSessionIdentity } from "../utils/incoming-policy.js";
import type { WhatsAppProvider } from "../providers/whatsapp/whatsapp-provider.interface.js";
import { HttpError } from "../utils/http-error.js";
import { normalizeInternationalPhone, toChatId } from "../utils/whatsapp-id.js";

export interface OwnerSettings {
  translate_owner_answer?: boolean; behavior?: Record<string,unknown>; templates?: Record<string,Record<string,string>>;
  owner_phone: string | null; owner_chat_id: string | null; pending_owner_phone?: string | null;
  owner_pairing_hash?: string | null; owner_pairing_expires_at?: string | null;
  quiet_hours_start: string | null; quiet_hours_end: string | null;
  mode: string; time_zone?: string; auto_replies_paused: boolean;
  exceptions?: ScheduleException[];
}
export interface ScheduleException {
  id:string;start_date:string;end_date:string;kind:'day_off'|'special_hours';
  work_start:string|null;work_end:string|null;name:string;recurs_annually:boolean;
}
const SETTINGS_TTL_MS = 10 * 60_000;
const settingsCaches = new WeakMap<DatabaseClient, Map<string, { value: OwnerSettings; expiresAt: number }>>();
export function invalidateOwnerSettings(db: DatabaseClient, tenantId: string): void {
  settingsCaches.get(db)?.delete(tenantId);
}
export async function loadOwnerSettings(db: DatabaseClient, tenantId: string): Promise<OwnerSettings> {
  let cache = settingsCaches.get(db);
  if (!cache) { cache = new Map(); settingsCaches.set(db, cache); }
  const cached = cache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const { data, error } = await db.from("notification_settings").select("owner_phone,owner_chat_id,pending_owner_phone,owner_pairing_hash,owner_pairing_expires_at,quiet_hours_start,quiet_hours_end,mode,time_zone,auto_replies_paused,translate_owner_answer,behavior,templates").eq("tenant_id",tenantId).maybeSingle();
  if (error) throw new Error("Owner settings lookup failed");
  const exceptions=await db.from('schedule_exceptions').select('id,start_date,end_date,kind,work_start,work_end,name,recurs_annually').eq('tenant_id',tenantId).order('start_date');
  if(exceptions.error)throw new Error('Schedule exceptions lookup failed');
  const value = data ? {...data,exceptions:exceptions.data??[]} as unknown as OwnerSettings : { owner_phone:null,owner_chat_id:null,quiet_hours_start:null,quiet_hours_end:null,mode:"mute_all",time_zone:"Asia/Jerusalem",auto_replies_paused:false,exceptions:[] };
  cache.set(tenantId, { value, expiresAt: Date.now() + SETTINGS_TTL_MS });
  return value;
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
/**
 * Z9: quiet hours and the time zone are optional here — «Настройки» saves them with the other settings
 * (saveRuntimeSettings); onboarding still sends them with the number. An absent key leaves the stored value.
 */
function optionalOwnerFields(input: Record<string,unknown>): Record<string,unknown> {
  const out: Record<string,unknown> = {};
  if ('quietStart' in input || 'quietEnd' in input) {
    const start = input.quietStart || null; const end = input.quietEnd || null;
    const validTime = (v: unknown) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
    if ((start || end) && (!validTime(start) || !validTime(end) || start === end)) throw new HttpError(400,"Укажите начало и окончание тихих часов.");
    out.quiet_hours_start = start; out.quiet_hours_end = end;
  }
  if ('timeZone' in input) {
    if (!supportedTimeZone(input.timeZone)) throw new HttpError(400,"Выберите часовой пояс владельца из списка.");
    out.time_zone = input.timeZone;
  }
  return out;
}
export interface SavedOwnerSettings { phone: string; code: string; ttlMinutes: number }
export async function saveOwnerSettings(db: DatabaseClient, tenantId: string, input: Record<string,unknown>, me: SessionIdentity): Promise<SavedOwnerSettings> {
  const phone = normalizeInternationalPhone(input.phone);
  if (!phone) throw new HttpError(400,"Укажите номер владельца с кодом страны, например +972501234567.");
  if (!me.id) throw new HttpError(409,"Сначала подключите бизнес-номер WhatsApp.");
  if (ownerIdentityField(toChatId(phone),me)) throw new HttpError(400,"Номер владельца должен отличаться от бизнес-номера WhatsApp.");
  const optional = optionalOwnerFields(input);
  const settings = await loadOwnerSettings(db,tenantId);
  const code = generatePairingCode();
  const ttlMinutes = Number(settings.behavior?.pairing_ttl_minutes ?? BEHAVIOR_DEFAULTS.pairing_ttl_minutes);
  // Z9: a different number replaces a set one only after it is confirmed — until then questions and requests
  // keep going to the current number (owner_phone / owner_chat_id); the new one waits in pending_owner_phone.
  const replacing = !!settings.owner_phone && settings.owner_phone !== phone;
  // The same number again (a new code) keeps its confirmed chat; no number yet — it is set right away.
  const owner = replacing ? { pending_owner_phone: phone } : settings.owner_phone ? { pending_owner_phone: null } : { owner_phone: phone, owner_chat_id: null, pending_owner_phone: null };
  const { error } = await db.from("notification_settings").upsert({tenant_id:tenantId,time_zone:settings.time_zone??DEFAULT_TIME_ZONE,...owner,...optional,
    owner_pairing_hash:hash(code),owner_pairing_expires_at:new Date(Date.now()+ttlMinutes*60*1000).toISOString(),mode:"mute_all"},{onConflict:"tenant_id"});
  if(error) throw new Error("Owner settings save failed");
  invalidateOwnerSettings(db,tenantId);
  if(Object.keys(optional).some(key=>(settings as unknown as Record<string,unknown>)[key]!==optional[key])){
    const updated=await loadOwnerSettings(db,tenantId);
    const {rescheduleOwnerSummary}=await import('./owner-summary.service.js');
    const {rescheduleTenantEscalationTimeouts}=await import('./owner-workflow.service.js');
    await rescheduleOwnerSummary(db,tenantId,updated);
    await rescheduleTenantEscalationTimeouts(db,tenantId,updated);
  }
  return { phone, code, ttlMinutes };
}
/**
 * Z6 onboarding: the owner's number before the business WhatsApp is connected (the pairing code can only be sent
 * from that session). Phone, time zone and quiet hours are saved; no code is issued and no pairing is pending, so
 * customer traffic is never intercepted. After the QR connection the same request sends the code (submitOwnerSettings).
 */
export async function savePendingOwnerSettings(db: DatabaseClient, tenantId: string, input: Record<string,unknown>): Promise<{ phone: string }> {
  const phone = normalizeInternationalPhone(input.phone);
  if (!phone) throw new HttpError(400,"Укажите номер владельца с кодом страны, например +972501234567.");
  const optional = optionalOwnerFields(input);
  const { error } = await db.from("notification_settings").upsert({tenant_id:tenantId,time_zone:(await loadOwnerSettings(db,tenantId)).time_zone??DEFAULT_TIME_ZONE,owner_phone:phone,owner_chat_id:null,pending_owner_phone:null,...optional,
    owner_pairing_hash:null,owner_pairing_expires_at:null,mode:"mute_all"},{onConflict:"tenant_id"});
  if(error) throw new Error("Owner settings save failed");
  invalidateOwnerSettings(db,tenantId);
  return { phone };
}

/** The owner-settings request: with a working business session — save and send the pairing code; without one —
 *  save the number only and say the code comes after the WhatsApp connection (Z6, onboarding before the QR). */
export async function submitOwnerSettings(db: DatabaseClient, tenantId: string, input: Record<string,unknown>, provider: WhatsAppProvider, session: string | null,
  send: (session: string, chatId: string, text: string) => Promise<void>): Promise<{ sent: true } | { sent: false; pending: 'whatsapp' }> {
  const status = session ? await provider.getSessionStatus(session) : null;
  if (!session || status?.status !== 'WORKING') { await savePendingOwnerSettings(db, tenantId, input); return { sent: false, pending: 'whatsapp' }; }
  const saved = await saveOwnerSettings(db, tenantId, input, readSessionIdentity(status.me));
  const settings = await loadOwnerSettings(db, tenantId);
  const { renderText } = await import('./templates.service.js');
  const { behavior } = await import('./runtime-settings.service.js');
  const text = renderText(settings, 'owner.pairing_code', behavior(settings).owner_language, { code: saved.code, minutes: String(saved.ttlMinutes) });
  try { await send(session, toChatId(saved.phone), text); }
  catch { throw new HttpError(422,'Не удалось отправить код подтверждения владельцу.'); }
  return { sent: true };
}
export async function pairOwner(db: DatabaseClient,tenantId:string,from:string,text:string,settings:OwnerSettings):Promise<boolean> {
  // No pairing in progress: never intercept the message, so ordinary customer traffic
  // (which may well contain a bare number) flows through untouched.
  if(!settings.owner_pairing_hash || !settings.owner_pairing_expires_at || Date.parse(settings.owner_pairing_expires_at)<=Date.now()) return false;
  const match = /^\D*(\d{6})\D*$/.exec(text.trim());
  if(!match) return false;
  // Z9: the code confirms the number it was sent to — the pending one when the owner is changing numbers.
  const pending=settings.pending_owner_phone||null;
  const confirming=pending?{...settings,owner_phone:pending,owner_chat_id:null}:settings;
  if(hash(match[1]!)!==settings.owner_pairing_hash || (!from.endsWith("@lid") && !isBusinessOwner(from,confirming))) return true;
  const {error}=await db.from("notification_settings").update({...(pending?{owner_phone:pending,pending_owner_phone:null}:{}),owner_chat_id:from,owner_pairing_hash:null,owner_pairing_expires_at:null})
    .eq("tenant_id",tenantId).eq("owner_pairing_hash",settings.owner_pairing_hash);
  if(error) throw new Error("Owner pairing failed");
  invalidateOwnerSettings(db,tenantId);
  return true;
}
