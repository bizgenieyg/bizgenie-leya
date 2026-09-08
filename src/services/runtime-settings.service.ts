import { BEHAVIOR_DEFAULTS } from '../config/behavior.js';
import { BASIC_USAGE_LIMITS } from '../config/usage.js';
import { TEMPLATE_DEFAULTS } from '../config/templates.js';
import { loadOwnerSettings, type OwnerSettings } from './owner-settings.service.js';
import type { DatabaseClient } from '../db/supabase.js';
import { HttpError } from '../utils/http-error.js';
import { validTimeZone } from '../utils/time-zone.js';
export function behavior(settings:OwnerSettings) {return {...BEHAVIOR_DEFAULTS,...settings.behavior} as typeof BEHAVIOR_DEFAULTS;}
export async function readRuntimeSettings(db:DatabaseClient,tenantId:string){
 const owner=await loadOwnerSettings(db,tenantId);
 const {data,error}=await db.from('tenant_usage_limits').select('messages_per_month,voice_minutes_per_month,warning_percent').eq('tenant_id',tenantId).maybeSingle();
 if(error)throw new Error('Tenant limits unavailable');
 return { ...behavior(owner),translate_owner_answer:owner.translate_owner_answer??BEHAVIOR_DEFAULTS.translate_owner_answer,
 messages_per_month:data?.messages_per_month??BASIC_USAGE_LIMITS.messagesPerMonth,
 voice_minutes_per_month:data?.voice_minutes_per_month??BASIC_USAGE_LIMITS.voiceSecondsPerMonth/60,
 warning_percent:data?.warning_percent??BASIC_USAGE_LIMITS.warningPercent,
 auto_replies_paused:owner.auto_replies_paused,owner_phone:owner.owner_phone??'',paired:!!owner.owner_chat_id,
 time_zone:owner.time_zone??'UTC',quiet_hours_start:owner.quiet_hours_start?.slice(0,5)??'',quiet_hours_end:owner.quiet_hours_end?.slice(0,5)??''};
}
export function validateRuntimePatch(input:Record<string,unknown>) {
 const limits:Record<string,unknown>={},notification:Record<string,unknown>={},behaviorPatch:Record<string,unknown>={};
 const integer=(key:string,value:unknown,min:number,max:number)=>{if(!Number.isSafeInteger(value)||Number(value)<min||Number(value)>max)throw new HttpError(400,`Invalid setting: ${key}`);return value;};
 for(const [key,value]of Object.entries(input)){
  if(['messages_per_month','voice_minutes_per_month'].includes(key))limits[key]=integer(key,value,0,2147483647);
  else if(key==='warning_percent')limits[key]=integer(key,value,1,100);
  else if(['translate_owner_answer','auto_replies_paused'].includes(key)){if(typeof value!=='boolean')throw new HttpError(400,'Expected boolean');notification[key]=value;}
  else if(['escalation_remind_minutes','escalation_close_minutes','usage_failure_alert_minutes','pairing_ttl_minutes','scheduler_interval_seconds','stt_timeout_seconds','media_max_bytes'].includes(key))behaviorPatch[key]=integer(key,value,1,2147483647);
  else if(key==='stt_confidence_threshold'){if(typeof value!=='number'||value<0||value>1)throw new HttpError(400,'Invalid confidence');behaviorPatch[key]=value;}
  else if(key==='enabled_agents'){if(!Array.isArray(value)||!value.length||value.some(v=>typeof v!=='string'||!/^[A-Z][A-Z0-9_]*$/.test(v)))throw new HttpError(400,'Invalid agents');behaviorPatch[key]=[...new Set(value)];}
  else if(key==='default_agent'){if(typeof value!=='string'||!/^[A-Z][A-Z0-9_]*$/.test(value))throw new HttpError(400,'Invalid agent');behaviorPatch[key]=value;}
  else if(key==='agent_overrides'){
   if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(400,'Invalid agent overrides');
   for(const [name,raw]of Object.entries(value)){
    if(!/^[A-Z][A-Z0-9_]*$/.test(name)||!raw||typeof raw!=='object'||Array.isArray(raw))throw new HttpError(400,'Invalid agent override');
    const o=raw as Record<string,unknown>;
    if(Object.keys(o).some(k=>!['priority','keywords','systemPrompt'].includes(k))||o.priority!==undefined&&!Number.isSafeInteger(o.priority)||o.keywords!==undefined&&(!Array.isArray(o.keywords)||o.keywords.some(k=>typeof k!=='string'||!k.trim()))||o.systemPrompt!==undefined&&typeof o.systemPrompt!=='string')throw new HttpError(400,'Invalid agent override');
   }behaviorPatch[key]=value;
  }else if(key==='owner_language'){if(!['he','ru','en'].includes(String(value)))throw new HttpError(400,'Invalid language');behaviorPatch[key]=value;}
  else if(key==='time_zone'){if(typeof value!=='string'||!validTimeZone(value))throw new HttpError(400,'Invalid timezone');notification[key]=value;}
  else if(['quiet_hours_start','quiet_hours_end'].includes(key)){if(value!==''&&value!==null&&(typeof value!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)))throw new HttpError(400,'Invalid quiet hours');notification[key]=value||null;}
  else if(key==='templates'){
   if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(400,'Invalid templates');
   for(const[k,languages]of Object.entries(value)){
    if(!TEMPLATE_DEFAULTS[k]||!languages||typeof languages!=='object')throw new HttpError(400,'Unknown template');
    const allowed=new Set(Object.values(TEMPLATE_DEFAULTS[k]!).flatMap(t=>t.match(/\{[a-z_]+\}/g)??[]));
    for(const[lang,t]of Object.entries(languages))if(!['he','ru','en'].includes(lang)||typeof t!=='string'||!t.trim()||/[<>]/.test(t)||(t.match(/\{[^}]*\}/g)??[]).some(p=>!allowed.has(p)))throw new HttpError(400,'Invalid template placeholders');
   }notification.templates=value;
  }else throw new HttpError(400,`Unknown setting: ${key}`);
 }
 return {limits,notification,behaviorPatch};
}
export async function saveRuntimeSettings(db:DatabaseClient,tenantId:string,input:Record<string,unknown>){
 const patch=validateRuntimePatch(input),existing=await loadOwnerSettings(db,tenantId);
 const merged={...behavior(existing),...patch.behaviorPatch};
 if(Number(merged.escalation_close_minutes)<=Number(merged.escalation_remind_minutes))throw new HttpError(400,'Close timeout must exceed reminder timeout');
 if(!merged.enabled_agents.includes(merged.default_agent))throw new HttpError(400,'Default agent must be enabled');
 const n={...existing,...patch.notification};if(!!n.quiet_hours_start!==!!n.quiet_hours_end||n.quiet_hours_start&&n.quiet_hours_start===n.quiet_hours_end)throw new HttpError(400,'Invalid quiet hours');
 const result=await db.rpc('update_tenant_runtime_settings',{p_tenant_id:tenantId,p_limits:patch.limits,p_notification:patch.notification,p_behavior:patch.behaviorPatch});
 if(result.error)throw new Error('Settings save failed');
 return readRuntimeSettings(db,tenantId);
}
