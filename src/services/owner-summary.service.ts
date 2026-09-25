import { markSuggestionsOffered, summarySuggestionBlock } from './knowledge-suggestions.service.js';
import type { DatabaseClient } from '../db/supabase.js';
import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { HttpError } from '../utils/http-error.js';
import { allowedRecipient,ownerIdentityField,readSessionIdentity } from '../utils/incoming-policy.js';
import { isWithinQuietHours } from './escalation.service.js';
import { enqueueMessage } from '../workers/outbound-queue.js';
import { behavior } from './runtime-settings.service.js';
import { loadOwnerSettings,ownerDestination,type OwnerSettings } from './owner-settings.service.js';
import { renderText } from './templates.service.js';
import { zonedDateTimeFormat } from '../utils/time-zone.js';
import { OWNER_SUMMARY_LEASE_MS,OWNER_SUMMARY_MAX_ATTEMPTS,OWNER_SUMMARY_RETRY_MS } from '../config/owner-summary.js';
import { scheduleWake } from '../workers/job-wake.js';
const OPEN=['queued','notifying','pending','reminding','delivering','delivery_uncertain','closing'];
const fail=()=>{throw new HttpError(500,'Could not build owner summary');};
/** Requests still waiting for the owner, regardless of the summary period. */
export async function openRequests(db:DatabaseClient,tenantId:string):Promise<Array<{name:string;summary:string}>>{
 const rows=await db.from('escalations').select('client_name,question,created_at').eq('tenant_id',tenantId).eq('kind','request').in('status',['queued','notifying','pending','reminding']).order('created_at',{ascending:true}).limit(20);
 if(rows.error)fail();
 return (rows.data??[]).map(row=>({name:String(row.client_name??''),summary:String(row.question??'').split('\n')[0]!.slice(0,200)}));
}
export async function buildOwnerSummary(db:DatabaseClient,tenantId:string,from:Date,to:Date){
 const start=from.toISOString(),end=to.toISOString();
 const individualClients=await db.from('clients').select('id,first_seen_at').eq('tenant_id',tenantId).eq('chat_type','individual');
 if(individualClients.error)fail();
 const clientRows=individualClients.data??[],clientIds=clientRows.map(row=>String(row.id));
 const conversations=clientIds.length?await db.from('conversations').select('id').eq('tenant_id',tenantId).in('client_id',clientIds):{data:[],error:null};
 if(conversations.error)fail();
 const conversationIds=(conversations.data??[]).map(row=>String(row.id));
 const empty={data:[],error:null};
 const [messages,escalations,knowledgeGaps]=await Promise.all([
  conversationIds.length?db.from('messages').select('conversation_id,from_me,msg_type').eq('tenant_id',tenantId).in('conversation_id',conversationIds).gte('created_at',start).lt('created_at',end):empty,
  conversationIds.length?db.from('escalations').select('conversation_id,status,question,answer,kind').eq('tenant_id',tenantId).in('conversation_id',conversationIds).gte('created_at',start).lt('created_at',end):empty,
  conversationIds.length?db.from('agent_actions').select('input').eq('tenant_id',tenantId).eq('action_type','knowledge_missing').in('conversation_id',conversationIds).gte('created_at',start).lt('created_at',end).not('input','is',null).limit(100):empty,]);
 if(messages.error||escalations.error||knowledgeGaps.error)fail();const escalationRows=escalations.data??[],escalated=new Set(escalationRows.map(row=>String(row.conversation_id))),inquiries=new Set((messages.data??[]).filter(row=>!row.from_me).map(row=>String(row.conversation_id))),answeredByBot=new Set((messages.data??[]).filter(row=>row.from_me&&!['owner_text','owner_media'].includes(String(row.msg_type))).map(row=>String(row.conversation_id))),counts=new Map<string,number>();for(const row of knowledgeGaps.data??[]){const clean=String(row.input??'').trim();if(clean)counts.set(clean,(counts.get(clean)??0)+1);}
 return{period_start:start,period_end:end,inquiries:inquiries.size,new_clients:clientRows.filter(row=>{const seen=new Date(String(row.first_seen_at)).getTime();return seen>=from.getTime()&&seen<to.getTime();}).length,closed_by_bot:[...answeredByBot].filter(id=>!escalated.has(id)).length,escalated:escalationRows.length,unanswered:escalationRows.filter(row=>row.kind!=='request'&&OPEN.includes(String(row.status))).length,open_requests:await openRequests(db,tenantId),missing_knowledge:[...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,5).map(([question,count])=>({question,count}))};
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
export function nextSummaryAt(settings:OwnerSettings,after:Date):Date|null{
 if(behavior(settings).summary_frequency==='off')return null;
 const current=summaryDue(settings,after)?.periodKey??null,start=after.getTime();
 let low=start;
 for(let step=1;step<=8*48;step++){
  const high=start+step*30*60_000,next=summaryDue(settings,new Date(high));
  if(next&&next.periodKey!==current){
   let left=low,right=high;
   while(right-left>1000){const middle=Math.floor((left+right)/2);if(summaryDue(settings,new Date(middle))?.periodKey===next.periodKey)right=middle;else left=middle;}
   return new Date(Math.floor(right/60_000)*60_000);
  }
  low=high;
 }
 return null;
}
export async function ensureOwnerSummaryJob(db:DatabaseClient,tenantId:string,settings:OwnerSettings,now=new Date()):Promise<void>{
 if(behavior(settings).summary_frequency==='off')return;
 const active=await db.from('scheduled_jobs').select('scheduled_at').eq('tenant_id',tenantId).eq('job_type','owner_summary')
  .in('status',['pending','sending']).order('scheduled_at',{ascending:true}).limit(1);if(active.error)fail();
 if(active.data?.length){scheduleWake(new Date(String(active.data[0]!.scheduled_at)));return;}
 let at=summaryDue(settings,now)?now:nextSummaryAt(settings,now);
 for(let period=0;at&&period<8;period++){
  const due=summaryDue(settings,at);if(!due)return;
  const existing=await db.from('scheduled_jobs').select('id,status').eq('tenant_id',tenantId).eq('job_type','owner_summary')
   .contains('payload',{period_key:due.periodKey}).maybeSingle();if(existing.error)fail();
  if(existing.data){
   if(existing.data.status==='cancelled'){
    const restored=await db.from('scheduled_jobs').update({status:'pending',scheduled_at:at.toISOString(),executed_at:null,error:null})
     .eq('id',existing.data.id).eq('status','cancelled');if(restored.error)fail();scheduleWake(at);return;
   }
   if(['pending','sending'].includes(String(existing.data.status))){scheduleWake(at);return;}
   at=nextSummaryAt(settings,at);
   continue;
  }
  const inserted=await db.from('scheduled_jobs').insert({tenant_id:tenantId,job_type:'owner_summary',
   payload:{period_key:due.periodKey},scheduled_at:at.toISOString(),status:'pending'});
  if(inserted.error?.code==='23505')continue;
  if(inserted.error)fail();
  scheduleWake(at);return;
 }
}
export async function rescheduleOwnerSummary(db:DatabaseClient,tenantId:string,settings:OwnerSettings,now=new Date()):Promise<void>{
 const cancelled=await db.from('scheduled_jobs').update({status:'cancelled',executed_at:now.toISOString()})
  .eq('tenant_id',tenantId).eq('job_type','owner_summary').eq('status','pending');if(cancelled.error)fail();
 await ensureOwnerSummaryJob(db,tenantId,settings,now);
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
 let sent=false;
 try{const language=behavior(settings).owner_language,suggestions=await summarySuggestionBlock(db,tenantId,settings,language);
  const {open_requests:_requests,missing_knowledge:_missing,...counts}=summary;
  const requests=summary.open_requests.length?renderText(settings,'owner.summary_requests',language,{count:summary.open_requests.length,items:summary.open_requests.map(r=>renderText(settings,'owner.summary_request_item',language,r)).join('\n')}):'';
  const summaryText=[renderText(settings,'owner.summary',language,{...counts,missing_knowledge:missing}),requests].filter(Boolean).join('\n\n');
  const queued=await enqueueMessage(db,tenantId,provider,{session,chatId:to,text:suggestions?`${summaryText}\n\n${suggestions.text}`:summaryText},{kind:'summary',dedupeKey:`summary:${claimed.id}`});
  if(suggestions)await markSuggestionsOffered(db,tenantId,suggestions.ids,queued.id);await db.from('scheduled_jobs').update({status:'done',executed_at:new Date().toISOString(),error:null}).eq('id',claimed.id);sent=true;}catch{const failure=summaryFailureState(claimed.attempts,now);await db.from('scheduled_jobs').update({status:failure.status,scheduled_at:failure.scheduled_at,error:'summary_delivery_failed'}).eq('id',claimed.id);if(failure.retry)scheduleWake(new Date(failure.scheduled_at));console.error('owner_summary_delivery_failed',{tenantId,attempt:claimed.attempts,retry:failure.retry});}
 if(sent)await ensureOwnerSummaryJob(db,tenantId,settings,now);
}
