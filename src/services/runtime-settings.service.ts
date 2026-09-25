import { BEHAVIOR_DEFAULTS, MESSAGE_RETENTION_MIN_DAYS } from '../config/behavior.js';
import { TEMPLATE_DEFAULTS } from '../config/templates.js';
import { invalidateOwnerSettings, loadOwnerSettings, type OwnerSettings } from './owner-settings.service.js';
import type { DatabaseClient } from '../db/supabase.js';
import { HttpError } from '../utils/http-error.js';
import { DEFAULT_TIME_ZONE,SUPPORTED_TIME_ZONES,supportedTimeZone } from '../config/time-zones.js';
import type { WeeklySchedule } from '../config/behavior.js';
import { logSystemEvent } from './logging.service.js';
import { invalidateTenantRouting } from './tenant.service.js';
import { DISCOVERY_MAX_CHARS, DISCOVERY_MAX_QUESTIONS, discoveryQuestions } from '../config/discovery.js';
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
 const tenant=await db.from('tenants').select('business_sector').eq('id',tenantId).single();
 if(tenant.error)throw new Error('Tenant profile unavailable');
 const {data,error}=await db.from('tenant_usage_limits').select('messages_per_month,voice_minutes_per_month,warning_percent,plan,messages_overridden,voice_overridden,warning_overridden').eq('tenant_id',tenantId).maybeSingle();
 if(error)throw new Error('Tenant limits unavailable');
 const planCode=data?.plan;
 const plan=planCode?await db.from('plans').select('code,display_name,messages_per_month,voice_minutes_per_month,warning_percent,unlimited').eq('code',planCode).maybeSingle():{data:null,error:{}};
 if(plan.error||!plan.data){console.error('critical_tenant_plan_integrity_violation',{tenantId});try{await logSystemEvent(db,{tenantId,level:'error',event:'tenant_plan_integrity_violation'});}catch{}throw new Error('Tenant plan unavailable');}
 const config=behavior(owner);
 return { ...config,client_discovery_questions:discoveryQuestions(config.client_discovery_questions,tenant.data.business_sector,config.cabinet_language??config.owner_language),business_sector:tenant.data.business_sector??null,translate_owner_answer:owner.translate_owner_answer??BEHAVIOR_DEFAULTS.translate_owner_answer,
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
  else if(key==='client_discovery_questions'){
   if(!Array.isArray(value)||value.length>DISCOVERY_MAX_QUESTIONS||value.some(q=>typeof q!=='string'||!q.trim()||q.trim().length>DISCOVERY_MAX_CHARS||/[<>{}]/.test(q)))throw new HttpError(400,'Invalid discovery questions');
   behaviorPatch[key]=value.map(q=>String(q).trim());
  }
  else if(key==='polish_owner_answer'){if(typeof value!=='boolean')throw new HttpError(400,'Expected boolean');behaviorPatch[key]=value;}
  else if(key==='auto_resume_hours')behaviorPatch[key]=integer(key,value,1,48);
  else if(key==='reception_max_messages')behaviorPatch[key]=integer(key,value,0,8760);
  else if(['simulator_hourly_limit','simulator_daily_limit','knowledge_max_files','knowledge_max_pdf_pages','knowledge_max_characters','knowledge_search_results','knowledge_indexing_hourly_limit','knowledge_indexing_daily_limit','knowledge_chunk_characters','knowledge_chunk_overlap'].includes(key))behaviorPatch[key]=integer(key,value,1,1000000);
  else if(['knowledge_max_file_bytes','knowledge_max_total_bytes'].includes(key))behaviorPatch[key]=integer(key,value,1024,1073741824);
  else if(key==='knowledge_similarity_threshold'){if(typeof value!=='number'||value<0||value>1)throw new HttpError(400,'Invalid knowledge threshold');behaviorPatch[key]=value;}
  else if(key==='message_retention_days')behaviorPatch[key]=integer(key,value,MESSAGE_RETENTION_MIN_DAYS,3650);
  else if(key==='lid_backfill_pause_ms')behaviorPatch[key]=integer(key,value,0,60000);
  else if(key==='knowledge_full_context_chars')behaviorPatch[key]=integer(key,value,0,500000);
  else if(key==='knowledge_unit_max_chars')behaviorPatch[key]=integer(key,value,200,20000);
  else if(key==='knowledge_similarity_floor'){if(typeof value!=='number'||value<0||value>1)throw new HttpError(400,'Invalid knowledge threshold');behaviorPatch[key]=value;}
  else if(key==='history_fetch_limit')behaviorPatch[key]=integer(key,value,0,100);
  else if(key==='history_max_characters')behaviorPatch[key]=integer(key,value,0,50000);
  else if(key==='history_timeout_seconds'||key==='lid_lookup_timeout_seconds')behaviorPatch[key]=integer(key,value,1,30);
  else if(key==='inbound_quiet_seconds')behaviorPatch[key]=integer(key,value,0,30);
  else if(['outbound_typing_min_seconds','outbound_typing_max_seconds','outbound_conversation_gap_min_seconds','outbound_conversation_gap_max_seconds','outbound_proactive_gap_min_seconds','outbound_proactive_gap_max_seconds'].includes(key))behaviorPatch[key]=integer(key,value,0,300);
  else if(['outbound_typing_seconds_per_100_min','outbound_typing_seconds_per_100_max'].includes(key)){
   if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>60)throw new HttpError(400,`Invalid setting: ${key}`);
   behaviorPatch[key]=value;
  }
  else if(key==='outbound_reminder_spread_minutes')behaviorPatch[key]=integer(key,value,0,20);
  else if(key==='daily_proactive_limit')behaviorPatch[key]=integer(key,value,0,1000);
  else if(key==='outbound_retention_days')behaviorPatch[key]=integer(key,value,1,365);
  else if(key==='outbound_retry_delays_seconds'){
   if(!Array.isArray(value)||value.length!==3||value.some(item=>!Number.isSafeInteger(item)||item<0||item>3600))throw new HttpError(400,'Invalid outbound retry delays');
   behaviorPatch[key]=value;
  }
  else if(['escalation_remind_minutes','escalation_close_minutes','usage_failure_alert_minutes','pairing_ttl_minutes','stt_timeout_seconds','media_max_bytes','deferred_max_age_hours','context_message_count','context_retention_hours'].includes(key))behaviorPatch[key]=integer(key,value,1,2147483647);
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
 const {business_sector,...runtimeInput}=input;
 if(business_sector!==undefined&&(business_sector!==null&&(typeof business_sector!=='string'||business_sector.trim().length>100)))throw new HttpError(400,'Invalid business sector');
 const patch=validateRuntimePatch(runtimeInput),existing=await loadOwnerSettings(db,tenantId);
 const merged={...behavior(existing),...patch.behaviorPatch};
 if(Number(merged.knowledge_chunk_overlap)>=Number(merged.knowledge_chunk_characters))throw new HttpError(400,'Knowledge chunk overlap must be smaller than chunk size');
 if(Number(merged.escalation_close_minutes)<=Number(merged.escalation_remind_minutes))throw new HttpError(400,'Close timeout must exceed reminder timeout');
 if(Number(merged.outbound_typing_min_seconds)>Number(merged.outbound_typing_max_seconds)||
    Number(merged.outbound_typing_seconds_per_100_min)>Number(merged.outbound_typing_seconds_per_100_max)||
    Number(merged.outbound_conversation_gap_min_seconds)>Number(merged.outbound_conversation_gap_max_seconds)||
    Number(merged.outbound_proactive_gap_min_seconds)>Number(merged.outbound_proactive_gap_max_seconds))throw new HttpError(400,'Outbound minimum must not exceed maximum');
 for(const route of [...merged.campaign_routes,...merged.source_routes])if(!merged.enabled_agents.includes(route.agent))throw new HttpError(400,'Route agent must be enabled');
 if(Object.keys(runtimeInput).length){
  const result=await db.rpc('update_tenant_runtime_settings',{p_tenant_id:tenantId,p_notification:patch.notification,p_behavior:patch.behaviorPatch,p_default_time_zone:DEFAULT_TIME_ZONE});
  if(result.error)throw new Error('Settings save failed');
  invalidateOwnerSettings(db,tenantId);
 }
 if(business_sector!==undefined){
  const sector=typeof business_sector==='string'?business_sector.trim():'';
  const result=await db.from('tenants').update({business_sector:sector||null}).eq('id',tenantId);
  if(result.error)throw new Error('Business sector save failed');
  invalidateTenantRouting(db,tenantId);
 }
 if(['summary_frequency','summary_time','summary_weekday','time_zone'].some(key=>key in runtimeInput)){
  const {rescheduleOwnerSummary}=await import('./owner-summary.service.js');
  await rescheduleOwnerSummary(db,tenantId,await loadOwnerSettings(db,tenantId));
 }
 if(['escalation_remind_minutes','escalation_close_minutes','deferred_max_age_hours','weekly_schedule','time_zone','auto_replies_paused'].some(key=>key in runtimeInput)){
  const {rescheduleTenantEscalationTimeouts}=await import('./owner-workflow.service.js');
  await rescheduleTenantEscalationTimeouts(db,tenantId,await loadOwnerSettings(db,tenantId));
 }
 return readRuntimeSettings(db,tenantId);
}
