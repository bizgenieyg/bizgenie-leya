import { BEHAVIOR_DEFAULTS, MESSAGE_RETENTION_MIN_DAYS } from '../config/behavior.js';
import { TEMPLATE_DEFAULTS } from '../config/templates.js';
import { loadOwnerSettings, type OwnerSettings } from './owner-settings.service.js';
import type { DatabaseClient } from '../db/supabase.js';
import { HttpError } from '../utils/http-error.js';
import { DEFAULT_TIME_ZONE,SUPPORTED_TIME_ZONES,supportedTimeZone } from '../config/time-zones.js';
import type { WeeklySchedule } from '../config/behavior.js';
import { logSystemEvent } from './logging.service.js';
export function behavior(settings:OwnerSettings) {
 const stored=settings.behavior&&typeof settings.behavior==='object'&&!Array.isArray(settings.behavior)?settings.behavior:{};
 return Object.fromEntries(Object.entries(BEHAVIOR_DEFAULTS).map(([key,fallback])=>[key,stored[key]??fallback])) as typeof BEHAVIOR_DEFAULTS;
}
export function templates(settings:OwnerSettings){
 const stored=settings.templates&&typeof settings.templates==='object'?settings.templates:{};
 return Object.fromEntries(Object.entries(TEMPLATE_DEFAULTS).map(([key,languages])=>[key,{...languages,...(stored[key]??{})}]));
}
export async function readRuntimeSettings(db:DatabaseClient,tenantId:string){
 const owner=await loadOwnerSettings(db,tenantId);
 const {data,error}=await db.from('tenant_usage_limits').select('messages_per_month,voice_minutes_per_month,warning_percent,plan,messages_overridden,voice_overridden,warning_overridden').eq('tenant_id',tenantId).maybeSingle();
 if(error)throw new Error('Tenant limits unavailable');
 const planCode=data?.plan;
 const plan=planCode?await db.from('plans').select('code,display_name,messages_per_month,voice_minutes_per_month,warning_percent,unlimited').eq('code',planCode).maybeSingle():{data:null,error:{}};
 if(plan.error||!plan.data){console.error('critical_tenant_plan_integrity_violation',{tenantId});try{await logSystemEvent(db,{tenantId,level:'error',event:'tenant_plan_integrity_violation'});}catch{}throw new Error('Tenant plan unavailable');}
 return { ...behavior(owner),translate_owner_answer:owner.translate_owner_answer??BEHAVIOR_DEFAULTS.translate_owner_answer,
 messages_per_month:data?.messages_overridden?data.messages_per_month:plan.data.messages_per_month,
 voice_minutes_per_month:data?.voice_overridden?data.voice_minutes_per_month:plan.data.voice_minutes_per_month,
 warning_percent:data?.warning_overridden?data.warning_percent:plan.data.warning_percent,plan:plan.data.code,plan_name:plan.data.display_name,unlimited:Boolean(plan.data.unlimited),
 auto_replies_paused:owner.auto_replies_paused??false,owner_phone:owner.owner_phone??'',paired:!!owner.owner_chat_id,
 time_zone:owner.time_zone??DEFAULT_TIME_ZONE,supported_time_zones:SUPPORTED_TIME_ZONES,weekly_schedule:normalizedSchedule(owner),templates:templates(owner),exceptions:owner.exceptions??[]};
}
const SYSTEM_FIELDS=new Set(['messages_per_month','voice_minutes_per_month','warning_percent','plan']);
const time=(v:unknown)=>typeof v==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(v);
export function normalizedSchedule(settings:OwnerSettings):WeeklySchedule {
 const configured=behavior(settings).weekly_schedule;
 if(validSchedule(configured))return configured;
 const day=settings.quiet_hours_start&&settings.quiet_hours_end
   ? {mode:'working_hours' as const,start:settings.quiet_hours_end.slice(0,5),end:settings.quiet_hours_start.slice(0,5)}
   : {mode:'working_day' as const};
 return Object.fromEntries(Array.from({length:7},(_,i)=>[String(i),day])) as WeeklySchedule;
}
function validSchedule(value:unknown):value is WeeklySchedule {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const schedule=value as Record<string,unknown>;
 return Array.from({length:7},(_,i)=>String(i)).every(day=>{
  const row=schedule[day];if(!row||typeof row!=='object'||Array.isArray(row))return false;
  const r=row as Record<string,unknown>;
  return r.mode==='working_day'||r.mode==='day_off'||(r.mode==='working_hours'&&time(r.start)&&time(r.end)&&r.start!==r.end);
 });
}
export function validateRuntimePatch(input:Record<string,unknown>) {
 const notification:Record<string,unknown>={},behaviorPatch:Record<string,unknown>={};
 const integer=(key:string,value:unknown,min:number,max:number)=>{if(!Number.isSafeInteger(value)||Number(value)<min||Number(value)>max)throw new HttpError(400,`Invalid setting: ${key}`);return value;};
 for(const [key,value]of Object.entries(input)){
  if(SYSTEM_FIELDS.has(key))throw new HttpError(403,'System settings cannot be changed by tenant');
  if(['translate_owner_answer','auto_replies_paused'].includes(key)){if(typeof value!=='boolean')throw new HttpError(400,'Expected boolean');notification[key]=value;}
  else if(['auto_resume_hours','reception_max_messages'].includes(key))behaviorPatch[key]=integer(key,value,0,8760);
  else if(key==='message_retention_days')behaviorPatch[key]=integer(key,value,MESSAGE_RETENTION_MIN_DAYS,3650);
  else if(['escalation_remind_minutes','escalation_close_minutes','usage_failure_alert_minutes','pairing_ttl_minutes','scheduler_interval_seconds','stt_timeout_seconds','media_max_bytes','deferred_max_age_hours','context_message_count','context_retention_hours'].includes(key))behaviorPatch[key]=integer(key,value,1,2147483647);
  else if(['stt_confidence_threshold','intent_confidence_threshold'].includes(key)){if(typeof value!=='number'||value<0||value>1)throw new HttpError(400,'Invalid confidence');behaviorPatch[key]=value;}
  else if(key==='route_stickiness_hours')behaviorPatch[key]=integer(key,value,1,8760);
  else if(key==='enabled_agents'){if(!Array.isArray(value)||!value.length||value.some(v=>typeof v!=='string'||!/^[A-Z][A-Z0-9_]*$/.test(v)))throw new HttpError(400,'Invalid agents');behaviorPatch[key]=[...new Set(value)];}
  else if(['campaign_routes','source_routes'].includes(key)){
   const selector=key==='campaign_routes'?'keyword':'source';
   if(!Array.isArray(value)||value.some(row=>!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).some(k=>![selector,'agent'].includes(k))||typeof (row as Record<string,unknown>)[selector]!=='string'||!(row as Record<string,unknown>)[selector]||typeof (row as Record<string,unknown>).agent!=='string'||!/^[A-Z][A-Z0-9_]*$/.test(String((row as Record<string,unknown>).agent))))throw new HttpError(400,`Invalid setting: ${key}`);
   behaviorPatch[key]=value;
  }
  else if(key==='agent_overrides'){
   if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(400,'Invalid agent overrides');
   for(const [name,raw]of Object.entries(value)){
    if(!/^[A-Z][A-Z0-9_]*$/.test(name)||!raw||typeof raw!=='object'||Array.isArray(raw))throw new HttpError(400,'Invalid agent override');
    const o=raw as Record<string,unknown>;
    if(Object.keys(o).some(k=>!['priority','keywords','systemPrompt'].includes(k))||o.priority!==undefined&&!Number.isSafeInteger(o.priority)||o.keywords!==undefined&&(!Array.isArray(o.keywords)||o.keywords.some(k=>typeof k!=='string'||!k.trim()))||o.systemPrompt!==undefined&&typeof o.systemPrompt!=='string')throw new HttpError(400,'Invalid agent override');
   }behaviorPatch[key]=value;
  }else if(['owner_language','cabinet_language'].includes(key)){if(!['he','ru','en'].includes(String(value)))throw new HttpError(400,'Invalid language');behaviorPatch[key]=value;}
  else if(key==='summary_frequency'){if(!['off','daily','weekly'].includes(String(value)))throw new HttpError(400,'Invalid summary frequency');behaviorPatch[key]=value;}
  else if(key==='summary_time'){if(!time(value))throw new HttpError(400,'Invalid summary time');behaviorPatch[key]=value;}
  else if(key==='summary_weekday')behaviorPatch[key]=integer(key,value,0,6);
  else if(key==='time_zone'){if(!supportedTimeZone(value))throw new HttpError(400,'Unsupported timezone');notification[key]=value;}
  else if(key==='weekly_schedule'){if(!validSchedule(value))throw new HttpError(400,'Invalid weekly schedule');behaviorPatch[key]=value;}
  else if(key==='templates'){
   if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(400,'Invalid templates');
   for(const[k,languages]of Object.entries(value)){
    if(!TEMPLATE_DEFAULTS[k]||!languages||typeof languages!=='object')throw new HttpError(400,'Unknown template');
    const allowed=new Set(Object.values(TEMPLATE_DEFAULTS[k]!).flatMap(t=>t.match(/\{[a-z_]+\}/g)??[]));
    for(const[lang,t]of Object.entries(languages))if(!['he','ru','en'].includes(lang)||typeof t!=='string'||!t.trim()||/[<>]/.test(t)||(t.match(/\{[^}]*\}/g)??[]).some(p=>!allowed.has(p)))throw new HttpError(400,'Invalid template placeholders');
   }notification.templates=value;
  }else throw new HttpError(400,`Unknown setting: ${key}`);
 }
 return {notification,behaviorPatch};
}
export async function saveRuntimeSettings(db:DatabaseClient,tenantId:string,input:Record<string,unknown>){
 const patch=validateRuntimePatch(input),existing=await loadOwnerSettings(db,tenantId);
 const merged={...behavior(existing),...patch.behaviorPatch};
 if(Number(merged.escalation_close_minutes)<=Number(merged.escalation_remind_minutes))throw new HttpError(400,'Close timeout must exceed reminder timeout');
 for(const route of [...merged.campaign_routes,...merged.source_routes])if(!merged.enabled_agents.includes(route.agent))throw new HttpError(400,'Route agent must be enabled');
 const result=await db.rpc('update_tenant_runtime_settings',{p_tenant_id:tenantId,p_notification:patch.notification,p_behavior:patch.behaviorPatch,p_default_time_zone:DEFAULT_TIME_ZONE});
 if(result.error)throw new Error('Settings save failed');
 return readRuntimeSettings(db,tenantId);
}
