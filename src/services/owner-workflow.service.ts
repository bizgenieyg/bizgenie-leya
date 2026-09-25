import { BEHAVIOR_DEFAULTS } from '../config/behavior.js';
import { behavior } from './runtime-settings.service.js';
import { activeElapsedMs } from './escalation.service.js';
import { renderText } from "./templates.service.js";
import { languageOf } from "./templates.service.js";
import { enqueueMessage, outboundIdsForProviderId, type OutboundKind } from '../workers/outbound-queue.js';
import type { AIProvider } from "../providers/ai/ai-provider.interface.js";
import { polishOwnerAnswer, translateOwnerAnswer } from "./ai-fallback.service.js";
import { loadContext } from "./context.service.js";
import { handleSuggestionReply, proposeKnowledgeSuggestion } from "./knowledge-suggestions.service.js";
import { formatPhone, storedPhone } from "../utils/whatsapp-id.js";
import { loadClientProfile } from "./client-profile.service.js";
import { randomUUID } from "node:crypto";
import { meterAI } from "./metered-providers.js";
import { createAIProvider } from "../providers/ai/index.js";
import type { DatabaseClient } from '../db/supabase.js';
import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { allowedRecipient, ownerIdentityField, readSessionIdentity } from '../utils/incoming-policy.js';
import { clientText, isDeferredAnswer, ownerAnswerText, replyId, waitingText, withoutRepeatedIntroduction } from '../utils/assistant-text.js';
import { buildEscalationText, isWithinQuietHours, nextQuietHoursEnd } from './escalation.service.js';
import { invalidateOwnerSettings, isBusinessOwner, loadOwnerSettings, ownerDestination, pairOwner, type OwnerSettings } from './owner-settings.service.js';
import { nextEscalationDeadline } from './escalation-deadline.js';
import { scheduleWake } from '../workers/job-wake.js';

export interface Escalation {
  id:string;tenant_id:string;conversation_id:string;client_chat_id:string;client_name:string;question:string;session:string;
  response_language?:string|null;
  pending_since?:string|null;reminded_at?:string|null;created_at?:string;
  inbound_id:string|null;status:string;owner_message_ids:string[];answer:string|null;learning_state:string;learning_message_ids:string[];
  client_message_id?:string|null;batch_id?:string|null;batch_position?:number;client_phone?:string|null;kind?:'question'|'request';
}
const JOB='owner_escalation';
const TIMEOUT_JOB='escalation_timeout';
function check(error:unknown) { if(error) throw new Error('Escalation persistence failed'); }
async function patch(db:DatabaseClient,e:Escalation,values:Record<string,unknown>) {
  const {error}=await db.from('escalations').update(values).eq('tenant_id',e.tenant_id).eq('id',e.id);check(error);
}
async function claim(db:DatabaseClient,e:Escalation,from:string,to:string):Promise<boolean> {
  const {data,error}=await db.from('escalations').update({status:to}).eq('tenant_id',e.tenant_id).eq('id',e.id).eq('status',from).select('id');check(error);return !!data?.length;
}
async function send(db:DatabaseClient,tenantId:string,provider:WhatsAppProvider,session:string,chatId:string,text:string,kind:OutboundKind='owner_notice',dedupeKey?:string,inboundMessageIds:string[]=[]):Promise<string> {
  if(!allowedRecipient(chatId)) throw new Error('Recipient policy blocked escalation');
  const result=await enqueueMessage(db,tenantId,provider,{session,chatId,text:clientText(text)},{kind,...(dedupeKey?{dedupeKey}:{}),inboundMessageIds});
  if(!result.id) throw new Error('Message delivery not confirmed');
  return result.id;
}
async function sendClient(db:DatabaseClient,provider:WhatsAppProvider,e:Escalation,text:string,kind:OutboundKind='reply',inboundMessageIds:string[]=[],dedupeKey?:string):Promise<string>{
 const c=await db.from('conversations').select('assistant_introduced_at').eq('tenant_id',e.tenant_id).eq('id',e.conversation_id).maybeSingle();check(c.error);
 const id=await send(db,e.tenant_id,provider,e.session,e.client_chat_id,withoutRepeatedIntroduction(text,!!c.data?.assistant_introduced_at),kind,dedupeKey,inboundMessageIds);
 const marked=await db.from('conversations').update({assistant_introduced_at:new Date().toISOString()}).eq('tenant_id',e.tenant_id).eq('id',e.conversation_id).is('assistant_introduced_at',null);check(marked.error);return id;
}
/** The exact client text for an owner answer; shared by real delivery and the simulator. */
export async function composeOwnerAnswer(db:DatabaseClient,tenantId:string,input:{question:string;answer:string;language:string;introduced:boolean},settings:OwnerSettings,ai?:AIProvider|null):Promise<string> {
  if(behavior(settings).polish_owner_answer&&ai){
    let context=null;
    try{context=await loadContext(db,tenantId);}catch{console.warn('owner_answer_polish_context_unavailable');}
    const polished=context?await polishOwnerAnswer(input.question,input.answer,context,input.language,
      meterAI(db,tenantId,ai,{purpose:'owner_answer_polish'}),input.introduced,meterAI(db,tenantId,ai,{purpose:'owner_answer_verify'})):null;
    if(polished)return withoutRepeatedIntroduction(polished,input.introduced);
  }
  const translated=(settings.translate_owner_answer ?? BEHAVIOR_DEFAULTS.translate_owner_answer) ? await translateOwnerAnswer(input.language,input.answer,ai) : input.answer;
  return withoutRepeatedIntroduction(ownerAnswerText(input.question,translated,settings,input.language),input.introduced);
}
export async function conversationPaused(db:DatabaseClient,tenantId:string,conversationId:string,settings?:OwnerSettings,now=new Date()):Promise<boolean> {
  const {data,error}=await db.from('conversations').select('bot_paused,owner_last_activity_at').eq('tenant_id',tenantId).eq('id',conversationId).maybeSingle();check(error);
  if(data?.bot_paused!==true)return false;
  const hours=Number(behavior(settings??({} as OwnerSettings)).auto_resume_hours);
  if(hours>0&&data.owner_last_activity_at&&now.getTime()-new Date(data.owner_last_activity_at).getTime()>=hours*3600000){
    const resumed=await db.from('conversations').update({bot_paused:false}).eq('tenant_id',tenantId).eq('id',conversationId);check(resumed.error);return false;
  }
  return true;
}
async function obsolete(db:DatabaseClient,e:Escalation,settings:OwnerSettings,now:Date):Promise<'owner'|'expired'|null>{
  const conversation=await db.from('conversations').select('owner_last_activity_at').eq('tenant_id',e.tenant_id).eq('id',e.conversation_id).maybeSingle();check(conversation.error);
  if(conversation.data?.owner_last_activity_at&&new Date(conversation.data.owner_last_activity_at)>new Date(e.created_at??0))return 'owner';
  if(now.getTime()-new Date(e.created_at??now).getTime()>Number(behavior(settings).deferred_max_age_hours)*3600000)return 'expired';
  return null;
}
async function closeObsolete(db:DatabaseClient,e:Escalation,reason:'owner'|'expired',now:Date){
  await patch(db,e,{status:reason==='owner'?'resolved_by_owner':'expired',closed_at:now.toISOString()});
  const route=await db.from('conversations').update({routed_agent:null,route_selected_at:null}).eq('tenant_id',e.tenant_id).eq('id',e.conversation_id);check(route.error);
  const jobs=await db.from('scheduled_jobs').update({status:'cancelled',executed_at:now.toISOString(),error:reason}).eq('tenant_id',e.tenant_id).eq('job_type',JOB).contains('payload',{escalation_id:e.id}).eq('status','pending');check(jobs.error);
  await cancelEscalationTimeout(db,e,now);
}
export async function cancelEscalationTimeout(db:DatabaseClient,e:Pick<Escalation,'tenant_id'|'id'>,now=new Date()):Promise<void>{
  const result=await db.from('scheduled_jobs').update({status:'cancelled',executed_at:now.toISOString()})
    .eq('tenant_id',e.tenant_id).eq('job_type',TIMEOUT_JOB).contains('payload',{escalation_id:e.id}).in('status',['pending','sending']);
  check(result.error);
}
export async function scheduleEscalationTimeout(db:DatabaseClient,e:Escalation,settings:OwnerSettings,now=new Date(),notBefore?:Date):Promise<void>{
  const due=nextEscalationDeadline(settings,e,now);
  const at=notBefore&&notBefore>due?notBefore:due;
  const existing=await db.from('scheduled_jobs').select('id').eq('tenant_id',e.tenant_id).eq('job_type',TIMEOUT_JOB)
    .contains('payload',{escalation_id:e.id}).in('status',['pending','sending']).maybeSingle();check(existing.error);
  if(existing.data){
    const updated=await db.from('scheduled_jobs').update({status:'pending',scheduled_at:at.toISOString(),error:null})
      .eq('id',existing.data.id).in('status',['pending','sending']);check(updated.error);
  }else{
    const inserted=await db.from('scheduled_jobs').insert({tenant_id:e.tenant_id,job_type:TIMEOUT_JOB,
      payload:{escalation_id:e.id},scheduled_at:at.toISOString(),status:'pending'});
    if(inserted.error?.code!=='23505')check(inserted.error);
  }
  scheduleWake(at);
}
export async function rescheduleTenantEscalationTimeouts(db:DatabaseClient,tenantId:string,settings:OwnerSettings,now=new Date()):Promise<void>{
  const pending=await db.from('escalations').select('*').eq('tenant_id',tenantId).eq('status','pending');check(pending.error);
  for(const row of pending.data??[]){
    const e=row as Escalation;
    const expiry=new Date(new Date(e.created_at??now).getTime()+Number(behavior(settings).deferred_max_age_hours)*3_600_000+1);
    await scheduleEscalationTimeout(db,e,settings,now,settings.auto_replies_paused?expiry:undefined);
  }
}
/**
 * The client's real number for owner messages: the snapshot taken when the escalation was created,
 * else conversation → client (a merged @lid/@c.us client keeps its old whatsapp_jid, so never by chat id).
 */
async function escalationPhone(db:DatabaseClient,e:Escalation):Promise<string|null>{
  if(storedPhone(e.client_phone))return e.client_phone!;
  const conversation=await db.from('conversations').select('client_id').eq('tenant_id',e.tenant_id).eq('id',e.conversation_id).maybeSingle();check(conversation.error);
  if(!conversation.data?.client_id)return null;
  const client=await db.from('clients').select('phone').eq('tenant_id',e.tenant_id).eq('id',conversation.data.client_id).maybeSingle();check(client.error);
  return storedPhone(client.data?.phone);
}
/** 📩 request notice: what the client asks (+ named time) and up to two facts Leya already knows. */
async function requestNotice(db:DatabaseClient,e:Escalation,settings:OwnerSettings,phone:string|null):Promise<string>{
  const conversation=await db.from('conversations').select('client_id').eq('tenant_id',e.tenant_id).eq('id',e.conversation_id).maybeSingle();check(conversation.error);
  const profile=conversation.data?.client_id?await loadClientProfile(db,e.tenant_id,String(conversation.data.client_id)):'';
  const known=profile.split('\n').map(line=>line.replace(/^- \d{2}\.\d{2}: /,'').trim()).filter(Boolean).slice(-2);
  const summary=[...e.question.split('\n').slice(0,3),...known].slice(0,5).join('\n');
  const text=renderText(settings,'owner.request',behavior(settings).owner_language,{name:e.client_name,phone:phone??'',summary});
  return phone?text:text.replace(/\s*\(\s*\)/,'');
}
export async function openRequestFor(db:DatabaseClient,tenantId:string,conversationId:string):Promise<Escalation|null>{
  const found=await db.from('escalations').select('*').eq('tenant_id',tenantId).eq('conversation_id',conversationId).eq('kind','request')
    .in('status',['queued','notifying','pending','reminding','answered','delivering']).limit(1);check(found.error);
  return (found.data?.[0] as Escalation|undefined)??null;
}
/**
 * Owner request: one open request per client conversation. A repeat extends its text silently
 * (no new owner message); the client hears the request is already with the owner.
 */
export async function createOwnerRequest(db:DatabaseClient,provider:WhatsAppProvider,input:Omit<Escalation,'id'|'status'|'owner_message_ids'|'answer'|'learning_state'|'learning_message_ids'>,settings:OwnerSettings,summary:string,repeatReply:string|null):Promise<string|null>{
  const tenant=await db.from('tenants').select('name').eq('id',input.tenant_id).maybeSingle();check(tenant.error);
  const ownerName=String(tenant.data?.name??'');
  const language=input.response_language??languageOf(input.question);
  const open=await openRequestFor(db,input.tenant_id,input.conversation_id);
  if(open){
    const lines=new Set(open.question.split('\n'));
    const extra=summary.split('\n').filter(line=>line.trim()&&!lines.has(line));
    if(extra.length)await patch(db,open,{question:[open.question,...extra].join('\n').slice(0,2000)});
    const text=repeatReply??renderText(settings,'client.request_repeat',language,{owner_name:ownerName});
    await sendClient(db,provider,{...open,client_chat_id:input.client_chat_id,session:input.session},text,'reply',[],`request:${open.id}:repeat:${input.inbound_id??randomUUID()}`);
    return withoutRepeatedIntroduction(text,true);
  }
  const text=renderText(settings,'client.request_sent',language,{owner_name:ownerName});
  return (await createEscalation(db,provider,{...input,question:summary},settings,null,{kind:'request',clientText:text}))??null;
}
export async function notifyOwner(db:DatabaseClient,provider:WhatsAppProvider,e:Escalation,settings:OwnerSettings):Promise<boolean> {
  const now=new Date(),stale=await obsolete(db,e,settings,now);if(stale){await closeObsolete(db,e,stale,now);return false;}
  const destination=ownerDestination(settings);
  if(!destination||!allowedRecipient(destination)) return false;
  // A business-line change must never turn notifications into self-chat.
  const me=readSessionIdentity((await provider.getSessionStatus(e.session)).me);
  if(!me.id || ownerIdentityField(destination,me) || ownerIdentityField(`${settings.owner_phone}@c.us`,me)) {
    console.warn('escalation_owner_identity_unavailable_or_self');return false;
  }
  if(!await claim(db,e,'queued','notifying')) return false;
  let pendingSince:Date;
  try {
    const phone=formatPhone(await escalationPhone(db,e));
    const text=e.kind==='request'?await requestNotice(db,e,settings,phone):buildEscalationText(e.client_name,e.question,settings,phone);
    const id=await send(db,e.tenant_id,provider,e.session,destination,text,'owner_notice',`escalation:${e.id}:notice`);
    pendingSince=new Date();
    await patch(db,e,{status:'pending',pending_since:pendingSince.toISOString(),owner_message_ids:[...new Set([...e.owner_message_ids,id])]});
  } catch {
    // Ambiguous network result: do not resend automatically and create duplicate questions.
    console.error('escalation_notification_uncertain',{tenantId:e.tenant_id,escalationId:e.id});
    throw new Error('Owner notification delivery uncertain');
  }
  await scheduleEscalationTimeout(db,{...e,pending_since:pendingSince.toISOString()},settings,pendingSince);
  return true;
}
/**
 * One escalation per question the knowledge base could not answer; one owner notification each
 * (a quoted reply maps to exactly one question) and ONE client message for the whole batch:
 * the answered part (if any) followed by the waiting text.
 */
export async function createEscalation(db:DatabaseClient,provider:WhatsAppProvider,input:Omit<Escalation,'id'|'status'|'owner_message_ids'|'answer'|'learning_state'|'learning_message_ids'>,settings:OwnerSettings,clientZone?:string|null,options:{questions?:string[];answered?:string|null;kind?:'question'|'request';clientText?:string}={}) {
  if(!ownerDestination(settings)) {console.warn('webhook_escalation_skipped',{reason:'missing_owner_phone'});return;}
  if(!allowedRecipient(ownerDestination(settings))) return;
  const questions=options.questions?.length?options.questions:[input.question];
  const batchId=questions.length>1?randomUUID():null;
  const rows:Escalation[]=[];
  for(const [position,question] of questions.entries()){
    const {data,error}=await db.from('escalations').insert({...input,question,batch_id:batchId,batch_position:position,kind:options.kind??'question'}).select('*').single();
    if(error?.code==='23505'){if(position===0)return;continue;}
    check(error); if(!data) throw new Error('Escalation not created');
    rows.push(data as unknown as Escalation);
  }
  const now=new Date(),quiet=isWithinQuietHours(settings,now);
  const quietEnd=quiet?nextQuietHoursEnd(settings,now):null;
  // Quiet with no working window ahead: schedule and notify now, promise a callback — never a far-future date.
  const scheduledAt=quietEnd??now;
  for(const e of rows){
    const {error:jobError}=await db.from('scheduled_jobs').insert({tenant_id:e.tenant_id,job_type:JOB,payload:{escalation_id:e.id},scheduled_at:scheduledAt.toISOString(),status:'pending'});check(jobError);
  }
  scheduleWake(scheduledAt);
  const first=rows[0]!;
  const waiting=escalationWaitingMessage(input.question,settings,clientZone,first.response_language??languageOf(input.question),now);
  const answered=options.answered?clientText(options.answered):'';
  const text=options.clientText??(answered?`${answered}\n\n${withoutRepeatedIntroduction(waiting.text,true)}`:waiting.text);
  await sendClient(db,provider,first,text,'reply',[],`escalation:${first.id}:waiting`);
  if(!quiet||!quietEnd) for(const e of rows) await notifyOwner(db,provider,e,settings);
  return text;
}

export function escalationWaitingMessage(question:string,settings:OwnerSettings,clientZone:string|null|undefined,responseLanguage:string,now=new Date()):{text:string;quietHours?:{active:true;until:string}} {
  const quiet=isWithinQuietHours(settings,now);
  const at=quiet?nextQuietHoursEnd(settings,now):null;
  return {
    text:waitingText(question,quiet?{at,ownerZone:settings.time_zone??'UTC',clientZone:clientZone??null}:undefined,settings,responseLanguage),
    ...(quiet&&at?{quietHours:{active:true as const,until:at.toISOString()}}:{}),
  };
}
export async function handleOwnerMessage(db:DatabaseClient,provider:WhatsAppProvider,tenantId:string,session:string,from:string,text:string,quoted:string|null,settings:OwnerSettings,ai?:AIProvider|null,inboundMessageId?:string|null):Promise<boolean> {
  if(await pairOwner(db,tenantId,from,text,settings)) return true;
  if(!isBusinessOwner(from,settings)) return false;
  const command=text.trim().toLowerCase().replace(/[.!]+$/,'');
  if(['пауза всё','пауза все','продолжить всё','продолжить все'].includes(command)) {
    const paused=command.startsWith('пауза');
    const {error}=await db.from('notification_settings').update({auto_replies_paused:paused}).eq('tenant_id',tenantId);check(error);
    invalidateOwnerSettings(db,tenantId);
    if(!paused) await rescheduleTenantEscalationTimeouts(db,tenantId,await loadOwnerSettings(db,tenantId),new Date());
    await send(db,tenantId,provider,session,from,paused?renderText(settings,'owner.owner_reply_5',behavior(settings).owner_language):renderText(settings,'owner.owner_reply_6',behavior(settings).owner_language));return true;
  }
  if(command==='диалоги') {
    const result=await db.from('conversations').select('id,client_id,bot_paused').eq('tenant_id',tenantId).eq('status','active').order('last_message_at',{ascending:false}).limit(20);check(result.error);
    const lines:string[]=[];
    for(const conversation of result.data??[]) {
      const client=await db.from('clients').select('name').eq('tenant_id',tenantId).eq('id',conversation.client_id).maybeSingle();check(client.error);
      lines.push(renderText(settings,'owner.dialog_line',behavior(settings).owner_language,{name:client.data?.name||'',paused:conversation.bot_paused?' ⏸':'',id:conversation.id}));
    }
    await send(db,tenantId,provider,session,from,lines.length?lines.join('\n\n'):renderText(settings,'owner.short_0',behavior(settings).owner_language));return true;
  }
  const direct=/^(пауза диалог|продолжить диалог|беру на себя) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(command);
  if(direct) {
    const paused=direct[1]!=='продолжить диалог';
    const result=await db.from('conversations').update({bot_paused:paused}).eq('tenant_id',tenantId).eq('id',direct[2]!).select('id');check(result.error);
    if(!paused&&result.data?.length) await rescheduleTenantEscalationTimeouts(db,tenantId,settings,new Date());
    await send(db,tenantId,provider,session,from,result.data?.length?(paused?renderText(settings,'owner.owner_reply_12',behavior(settings).owner_language):renderText(settings,'owner.short_1',behavior(settings).owner_language)):renderText(settings,'owner.short_2',behavior(settings).owner_language));return true;
  }
  if(!quoted) {await send(db,tenantId,provider,session,from,renderText(settings,'owner.owner_reply_15',behavior(settings).owner_language));return true;}
  // Stored ids are outbound queue row ids (legacy rows: WhatsApp ids); a quote carries the WhatsApp id.
  const outboundIds=await outboundIdsForProviderId(db,tenantId,quoted);
  if(await handleSuggestionReply(db,tenantId,outboundIds,text))return true;
  const keys=[replyId(quoted),...outboundIds];
  const byIds=async(column:'learning_message_ids'|'owner_message_ids')=>{
    for(const key of keys){const r=await db.from('escalations').select('*').eq('tenant_id',tenantId).contains(column,[key]).limit(1);check(r.error);if(r.data?.[0])return r.data[0] as Escalation;}
    return undefined;
  };
  const learned=await byIds('learning_message_ids');
  if(learned){
    if(learned.learning_state!=='awaiting') return true;
    if(['да','сохранить','yes','כן'].includes(command)){
      const {error}=await db.rpc('confirm_escalation_learning',{p_tenant_id:tenantId,p_escalation_id:learned.id});check(error);
      await send(db,tenantId,provider,session,from,renderText(settings,'owner.short_3',behavior(settings).owner_language));
    }else if(['нет','no','לא'].includes(command)){await patch(db,learned,{learning_state:'declined'});}
    return true;
  }
  const e=await byIds('owner_message_ids');
  if(!e) return true;
  if(['беру на себя','пауза','продолжить'].includes(command)) {
    const paused=command!=='продолжить';
    const {error}=await db.from('conversations').update({bot_paused:paused}).eq('tenant_id',tenantId).eq('id',e.conversation_id);check(error);
    if(!paused) await rescheduleTenantEscalationTimeouts(db,tenantId,settings,new Date());
    await send(db,tenantId,provider,session,from,paused?renderText(settings,'owner.owner_reply_22',behavior(settings).owner_language):renderText(settings,'owner.owner_reply_23',behavior(settings).owner_language));return true;
  }
  if(e.status!=='pending') return true;
  if(isDeferredAnswer(text)) {await send(db,tenantId,provider,session,from,renderText(settings,'owner.owner_reply_24',behavior(settings).owner_language));return true;}
  if(settings.auto_replies_paused||await conversationPaused(db,tenantId,e.conversation_id,settings)){
    await send(db,tenantId,provider,session,from,renderText(settings,'owner.owner_reply_25',behavior(settings).owner_language));return true;
  }
  const answer=clientText(text);if(!answer) return true;
  if(!allowedRecipient(e.client_chat_id)) return true;
  if(e.batch_id){
    // A batch answers the client once: park this answer until every sibling question is answered.
    if(!await claim(db,e,'pending','answered')) return true;
    await patch(db,e,{answer});
    await cancelEscalationTimeout(db,e);
    await deliverBatchIfReady(db,provider,e,settings,ai,false,inboundMessageId);
    return true;
  }
  if(!await claim(db,e,'pending','delivering')) return true;
  await patch(db,e,{answer});
  try {
    const responseLanguage=e.response_language??languageOf(e.question);
    const c=await db.from('conversations').select('assistant_introduced_at').eq('tenant_id',tenantId).eq('id',e.conversation_id).maybeSingle();check(c.error);
    const id=await sendClient(db,provider,e,await composeOwnerAnswer(db,tenantId,{question:e.question,answer,language:responseLanguage,introduced:!!c.data?.assistant_introduced_at},settings,ai),'owner_answer_delivery',inboundMessageId?[inboundMessageId]:[],`escalation:${e.id}:answer`);
    await patch(db,e,{status:'delivered',client_message_id:id,delivered_at:new Date().toISOString()});
    await cancelEscalationTimeout(db,e);
    const route=await db.from('conversations').update({routed_agent:null,route_selected_at:null}).eq('tenant_id',tenantId).eq('id',e.conversation_id);check(route.error);
  } catch {
    await patch(db,e,{status:'delivery_uncertain'});
    await cancelEscalationTimeout(db,e);
    console.error('escalation_client_delivery_uncertain',{tenantId,escalationId:e.id});
    await send(db,tenantId,provider,session,from,renderText(settings,'owner.owner_reply_26',behavior(settings).owner_language));return true;
  }
  return true;
}

const OPEN=['queued','notifying','pending','reminding'];
/**
 * Deliver the answered questions of a batch as one client message. Normally only when no sibling
 * is still open; `partial` (reminder deadline passed) sends what is answered plus a note that the
 * rest is still being checked. The lowest-position answered row acts as the delivery lock.
 */
async function deliverBatchIfReady(db:DatabaseClient,provider:WhatsAppProvider,e:Escalation,settings:OwnerSettings,ai:AIProvider|null|undefined,partial:boolean,inboundMessageId?:string|null):Promise<boolean>{
  const siblings=await db.from('escalations').select('*').eq('tenant_id',e.tenant_id).eq('batch_id',e.batch_id!).order('batch_position',{ascending:true});check(siblings.error);
  const rows=(siblings.data??[]) as Escalation[];
  const answered=rows.filter(row=>row.status==='answered'&&row.answer);
  const open=rows.filter(row=>OPEN.includes(row.status));
  if(!answered.length||(open.length&&!partial))return false;
  const lock=answered[0]!;
  if(!await claim(db,lock,'answered','delivering'))return false;
  const others=answered.slice(1);
  for(const row of others)await patch(db,row,{status:'delivering'});
  const group=[lock,...others];
  try{
    const language=lock.response_language??languageOf(lock.question);
    const c=await db.from('conversations').select('assistant_introduced_at').eq('tenant_id',lock.tenant_id).eq('id',lock.conversation_id).maybeSingle();check(c.error);
    const numbered=(values:string[])=>values.length===1?values[0]!:values.map((v,i)=>`${i+1}) ${v}`).join('\n');
    let text=await composeOwnerAnswer(db,lock.tenant_id,{question:numbered(group.map(r=>r.question)),answer:numbered(group.map(r=>r.answer??'')),language,introduced:!!c.data?.assistant_introduced_at},settings,ai);
    if(open.length)text=`${text}\n\n${renderText(settings,'client.partial_pending',language)}`;
    const id=await sendClient(db,provider,lock,text,'owner_answer_delivery',inboundMessageId?[inboundMessageId]:[],`escalation:${lock.id}:answer`);
    for(const row of group){await patch(db,row,{status:'delivered',client_message_id:id,delivered_at:new Date().toISOString()});await cancelEscalationTimeout(db,row);}
    if(!open.length){const route=await db.from('conversations').update({routed_agent:null,route_selected_at:null}).eq('tenant_id',lock.tenant_id).eq('id',lock.conversation_id);check(route.error);}
    return true;
  }catch{
    for(const row of group)await patch(db,row,{status:'delivery_uncertain'});
    console.error('escalation_client_delivery_uncertain',{tenantId:lock.tenant_id,escalationId:lock.id});
    return false;
  }
}

/** Called by the outbound sender when an owner-answer delivery reaches a final state. */
export async function onOwnerAnswerDeliveryOutcome(db:DatabaseClient,provider:WhatsAppProvider,row:{id:string;tenant_id:string;session:string},outcome:'sent'|'failed'):Promise<void>{
  const found=await db.from('escalations').select('*').eq('tenant_id',row.tenant_id).eq('client_message_id',row.id).eq('status','delivered');check(found.error);
  const delivered=(found.data??[]) as Escalation[];if(!delivered.length)return;
  // Sent: each Q/A pair is only *considered* for the knowledge base; the owner sees it in the next summary.
  if(outcome==='sent'){for(const e of delivered)await proposeKnowledgeSuggestion(db,e);return;}
  const settings=await loadOwnerSettings(db,row.tenant_id),owner=ownerDestination(settings);
  for(const e of delivered)await patch(db,e,{status:'delivery_uncertain'});
  console.error('escalation_client_delivery_uncertain',{tenantId:row.tenant_id,escalationId:delivered[0]!.id});
  if(owner&&allowedRecipient(owner))await send(db,row.tenant_id,provider,row.session,owner,renderText(settings,'owner.owner_reply_26',behavior(settings).owner_language));
}
export async function runDueScheduledEscalations(db:DatabaseClient,providerFor:()=>WhatsAppProvider,now=new Date(),tenantId?:string,jobId?:string):Promise<number> {
  let jobs=db.from('scheduled_jobs').select('id,tenant_id,payload').eq('job_type',JOB)
    .in('status',jobId?['pending','sending']:['pending']);
  if(!jobId)jobs=jobs.lte('scheduled_at',now.toISOString());
  if(tenantId)jobs=jobs.eq('tenant_id',tenantId);if(jobId)jobs=jobs.eq('id',jobId);
  const {data,error}=await jobs.limit(50);check(error);
  let count=0;
  for(const job of data??[]){
    try{
      const found=await db.from('escalations').select('*').eq('tenant_id',job.tenant_id).eq('id',job.payload.escalation_id).maybeSingle();check(found.error);
      const e=found.data as Escalation|null;if(!e){
        const missing=await db.from('scheduled_jobs').update({status:'done',executed_at:now.toISOString()}).eq('id',job.id);check(missing.error);continue;
      }
      if(e.status==='queued'){
        const settings=await loadOwnerSettings(db,e.tenant_id);
        const stale=await obsolete(db,e,settings,now);if(stale){await closeObsolete(db,e,stale,now);continue;}
        if(isWithinQuietHours(settings,now)){
          const next=nextQuietHoursEnd(settings,now);
          if(next){const deferred=await db.from('scheduled_jobs').update({status:'pending',scheduled_at:next.toISOString()}).eq('id',job.id);check(deferred.error);scheduleWake(next);}
          continue;
        }
        if(!await notifyOwner(db,providerFor(),e,settings)){
          const retry=new Date(now.getTime()+60_000),deferred=await db.from('scheduled_jobs').update({status:'pending',scheduled_at:retry.toISOString()}).eq('id',job.id);check(deferred.error);scheduleWake(retry);continue;
        }
        count++;
      }
      const done=await db.from('scheduled_jobs').update({status:'done',executed_at:now.toISOString()}).eq('tenant_id',job.tenant_id).eq('id',job.id);check(done.error);
    }catch{
      console.error('escalation_queue_failed',{tenantId:job.tenant_id,jobId:job.id});
      if(jobId)throw new Error('Scheduled escalation failed');
    }
  }
  return count;
}

export async function runEscalationTimeouts(db:DatabaseClient,providerFor:()=>WhatsAppProvider,now=new Date(),tenantId?:string,escalationId?:string){
 let pending=db.from('escalations').select('*').eq('status','pending');if(tenantId)pending=pending.eq('tenant_id',tenantId);if(escalationId)pending=pending.eq('id',escalationId);const {data,error}=await pending;check(error);
 for(const row of data??[]){
  const e=row as Escalation;
  try{
   const settings=await loadOwnerSettings(db,e.tenant_id),config=behavior(settings);
   const stale=await obsolete(db,e,settings,now);if(stale){await closeObsolete(db,e,stale,now);continue;}
   if(isWithinQuietHours(settings,now)||settings.auto_replies_paused||await conversationPaused(db,e.tenant_id,e.conversation_id,settings,now))continue;
   const elapsed=activeElapsedMs(settings,new Date(e.pending_since??e.created_at!),now);
   const provider=providerFor();
   if(elapsed>=config.escalation_close_minutes*60000){
    if(!await claim(db,e,'pending','closing'))continue;
    try{const id=await sendClient(db,provider,e,renderText(settings,'client.owner_timeout',e.response_language??languageOf(e.question)),'reply',[],`escalation:${e.id}:timeout`);
     await patch(db,e,{status:'closed_unanswered',closed_at:now.toISOString(),client_message_id:id});
     const route=await db.from('conversations').update({routed_agent:null,route_selected_at:null}).eq('tenant_id',e.tenant_id).eq('id',e.conversation_id);check(route.error);
    }catch{await patch(db,e,{status:'delivery_uncertain'});console.error('escalation_timeout_delivery_uncertain',{tenantId:e.tenant_id,escalationId:e.id});}
    await cancelEscalationTimeout(db,e,now);
   }else if(!e.reminded_at&&elapsed>=config.escalation_remind_minutes*60000){
    const to=ownerDestination(settings),me=readSessionIdentity((await provider.getSessionStatus(e.session)).me);
    if(!to||!me.id||ownerIdentityField(to,me)||ownerIdentityField(`${settings.owner_phone}@c.us`,me))continue;
    if(!await claim(db,e,'pending','reminding'))continue;
    try{const phone=formatPhone(await escalationPhone(db,e)),remind=renderText(settings,'owner.remind',config.owner_language,{name:e.client_name,phone:phone??'',question:e.question});
     const id=await send(db,e.tenant_id,provider,e.session,to,phone?remind:remind.replace(/\s*\(\s*\)/,''),'reminder',`escalation:${e.id}:remind`);
     await patch(db,e,{status:'pending',reminded_at:now.toISOString(),owner_message_ids:[...e.owner_message_ids,id]});
    }catch{await patch(db,e,{status:'pending',reminded_at:now.toISOString()});console.error('escalation_reminder_uncertain',{tenantId:e.tenant_id,escalationId:e.id});}
    // Some questions of the batch are answered while this one still waits: send what we have.
    if(e.batch_id)await deliverBatchIfReady(db,provider,e,settings,meterAI(db,e.tenant_id,createAIProvider()),true);
   }
  }catch{console.error('escalation_timeout_failed',{tenantId:e.tenant_id,escalationId:e.id});}
 }
}
