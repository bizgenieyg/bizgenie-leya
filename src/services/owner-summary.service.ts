import type { DatabaseClient } from '../db/supabase.js';
import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { HttpError } from '../utils/http-error.js';
import { allowedRecipient,ownerIdentityField,readSessionIdentity } from '../utils/incoming-policy.js';
import { isWithinQuietHours } from './escalation.service.js';
import { meterWhatsApp } from './metered-providers.js';
import { behavior } from './runtime-settings.service.js';
import { loadOwnerSettings,ownerDestination,type OwnerSettings } from './owner-settings.service.js';
import { renderText } from './templates.service.js';
import { zonedDateTimeFormat } from '../utils/time-zone.js';
import { OWNER_SUMMARY_LEASE_MS,OWNER_SUMMARY_MAX_ATTEMPTS,OWNER_SUMMARY_RETRY_MS } from '../config/owner-summary.js';
const OPEN=['queued','notifying','pending','reminding','delivering','delivery_uncertain','closing'];
const fail=()=>{throw new HttpError(500,'Could not build owner summary');};
export async function buildOwnerSummary(db:DatabaseClient,tenantId:string,from:Date,to:Date){
 const start=from.toISOString(),end=to.toISOString();const [messages,clients,escalations,unrecognized]=await Promise.all([
  db.from('messages').select('conversation_id,from_me,msg_type').eq('tenant_id',tenantId).gte('created_at',start).lt('created_at',end),db.from('clients').select('id').eq('tenant_id',tenantId).gte('first_seen_at',start).lt('first_seen_at',end),db.from('escalations').select('conversation_id,status,question,answer').eq('tenant_id',tenantId).gte('created_at',start).lt('created_at',end),db.from('unrecognized_routes').select('message_text').eq('tenant_id',tenantId).gte('created_at',start).lt('created_at',end).limit(100),]);
 if(messages.error||clients.error||escalations.error||unrecognized.error)fail();const escalationRows=escalations.data??[],escalated=new Set(escalationRows.map(row=>String(row.conversation_id))),inquiries=new Set((messages.data??[]).filter(row=>!row.from_me).map(row=>String(row.conversation_id))),answeredByBot=new Set((messages.data??[]).filter(row=>row.from_me&&!['owner_text','owner_media'].includes(String(row.msg_type))).map(row=>String(row.conversation_id)));const candidates=[...(unrecognized.data??[]).map(row=>String(row.message_text)),...escalationRows.filter(row=>row.answer).map(row=>String(row.question))],counts=new Map<string,number>();for(const text of candidates){const clean=text.trim();if(clean)counts.set(clean,(counts.get(clean)??0)+1);}
 return{period_start:start,period_end:end,inquiries:inquiries.size,new_clients:(clients.data??[]).length,closed_by_bot:[...answeredByBot].filter(id=>!escalated.has(id)).length,escalated:escalationRows.length,unanswered:escalationRows.filter(row=>OPEN.includes(String(row.status))).length,missing_knowledge:[...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,5).map(([question,count])=>({question,count}))};
}
function localParts(now:Date,zone:string){const p=zonedDateTimeFormat('en-CA',{year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'},zone).formatToParts(now),get=(t:string)=>p.find(x=>x.type===t)?.value??'';return{date:`${get('year')}-${get('month')}-${get('day')}`,weekday:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(get('weekday')),time:`${get('hour')}:${get('minute')}`};}
export function summaryDue(settings:OwnerSettings,now:Date){
 const c=behavior(settings),frequency=String(c.summary_frequency);if(frequency==='off')return null;
 const local=localParts(now,settings.time_zone??'Asia/Jerusalem'),at=String(c.summary_time);
 if(frequency==='daily'){if(local.time<at)return null;return{periodKey:`daily:${local.date}`,days:1};}
 const target=Number(c.summary_weekday),daysSince=(local.weekday-target+7)%7;if(daysSince===0&&local.time<at)return null;
 const scheduled=new Date(`${local.date}T00:00:00Z`);scheduled.setUTCDate(scheduled.getUTCDate()-daysSince);
 return{periodKey:`weekly:${scheduled.toISOString().slice(0,10)}`,days:7};
}
async function claimSummary(db:DatabaseClient,tenantId:string,periodKey:string,now:Date){
 const lease=new Date(now.getTime()+OWNER_SUMMARY_LEASE_MS).toISOString(),payload={period_key:periodKey,attempts:1};
 const inserted=await db.from('scheduled_jobs').insert({tenant_id:tenantId,job_type:'owner_summary',payload,scheduled_at:lease,status:'sending'}).select('id,payload').maybeSingle();
 if(!inserted.error&&inserted.data)return{id:String(inserted.data.id),attempts:1};if(inserted.error?.code!=='23505')throw new Error('Summary claim failed');
 const existing=await db.from('scheduled_jobs').select('id,status,payload,scheduled_at').eq('tenant_id',tenantId).eq('job_type','owner_summary').contains('payload',{period_key:periodKey}).maybeSingle();if(existing.error)throw new Error('Summary claim failed');const row=existing.data;if(!row||!['pending','sending'].includes(String(row.status))||new Date(String(row.scheduled_at)).getTime()>now.getTime())return null;
 const attempts=Number(row.payload?.attempts??0)+1;if(attempts>OWNER_SUMMARY_MAX_ATTEMPTS)return null;const claimed=await db.from('scheduled_jobs').update({status:'sending',scheduled_at:lease,payload:{...row.payload,attempts}}).eq('id',row.id).eq('status',row.status).eq('scheduled_at',row.scheduled_at).select('id').maybeSingle();if(claimed.error)throw new Error('Summary claim failed');return claimed.data?{id:String(row.id),attempts}:null;
}
export function summaryFailureState(attempts:number,now:Date){const retry=attempts<OWNER_SUMMARY_MAX_ATTEMPTS;return{retry,status:retry?'pending':'error',scheduled_at:retry?new Date(now.getTime()+OWNER_SUMMARY_RETRY_MS).toISOString():now.toISOString()};}
export async function deliverOwnerSummaryIfDue(db:DatabaseClient,tenantId:string,session:string,provider:WhatsAppProvider,now=new Date()){
 const settings=await loadOwnerSettings(db,tenantId),due=summaryDue(settings,now);if(!due||isWithinQuietHours(settings,now))return;const to=ownerDestination(settings);if(!to||!allowedRecipient(to))return;const me=readSessionIdentity((await provider.getSessionStatus(session)).me);if(!me.id||ownerIdentityField(to,me))return;
 const claimed=await claimSummary(db,tenantId,due.periodKey,now);if(!claimed)return;const summary=await buildOwnerSummary(db,tenantId,new Date(now.getTime()-due.days*86400000),now),missing=summary.missing_knowledge.length?summary.missing_knowledge.map(x=>`${x.question} (${x.count})`).join('; '):'—';
 try{await meterWhatsApp(db,tenantId,provider).sendMessage({session,chatId:to,text:renderText(settings,'owner.summary',behavior(settings).owner_language,{...summary,missing_knowledge:missing})});await db.from('scheduled_jobs').update({status:'done',executed_at:new Date().toISOString(),error:null}).eq('id',claimed.id);}catch{const failure=summaryFailureState(claimed.attempts,now);await db.from('scheduled_jobs').update({status:failure.status,scheduled_at:failure.scheduled_at,error:'summary_delivery_failed'}).eq('id',claimed.id);console.error('owner_summary_delivery_failed',{tenantId,attempt:claimed.attempts,retry:failure.retry});}
}
