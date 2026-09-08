import { BEHAVIOR_DEFAULTS } from '../config/behavior.js';
import { behavior } from './runtime-settings.service.js';
import { activeElapsedMs } from './escalation.service.js';
import { renderText } from "./templates.service.js";
import { meterWhatsApp } from "./metered-providers.js";
import type { AIProvider } from "../providers/ai/ai-provider.interface.js";
import { translateOwnerAnswer } from "./ai-fallback.service.js";
import type { DatabaseClient } from '../db/supabase.js';
import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { allowedRecipient, ownerIdentityField, readSessionIdentity } from '../utils/incoming-policy.js';
import { clientText, isDeferredAnswer, ownerAnswerText, replyId, waitingText } from '../utils/assistant-text.js';
import { buildEscalationText, isWithinQuietHours, nextQuietHoursEnd } from './escalation.service.js';
import { isBusinessOwner, loadOwnerSettings, ownerDestination, pairOwner, type OwnerSettings } from './owner-settings.service.js';

export interface Escalation {
  id:string;tenant_id:string;conversation_id:string;client_chat_id:string;client_name:string;question:string;session:string;
  pending_since?:string|null;reminded_at?:string|null;created_at?:string;
  inbound_id:string|null;status:string;owner_message_ids:string[];answer:string|null;learning_state:string;learning_message_ids:string[];
}
const JOB='owner_escalation';
function check(error:unknown) { if(error) throw new Error('Escalation persistence failed'); }
async function patch(db:DatabaseClient,e:Escalation,values:Record<string,unknown>) {
  const {error}=await db.from('escalations').update(values).eq('tenant_id',e.tenant_id).eq('id',e.id);check(error);
}
async function claim(db:DatabaseClient,e:Escalation,from:string,to:string):Promise<boolean> {
  const {data,error}=await db.from('escalations').update({status:to}).eq('tenant_id',e.tenant_id).eq('id',e.id).eq('status',from).select('id');check(error);return !!data?.length;
}
async function send(provider:WhatsAppProvider,session:string,chatId:string,text:string):Promise<string> {
  if(!allowedRecipient(chatId)) throw new Error('Recipient policy blocked escalation');
  const result=await provider.sendMessage({session,chatId,text:clientText(text)});
  if(!result.id) throw new Error('Message delivery not confirmed');
  return result.id;
}
export async function conversationPaused(db:DatabaseClient,tenantId:string,conversationId:string):Promise<boolean> {
  const {data,error}=await db.from('conversations').select('bot_paused').eq('tenant_id',tenantId).eq('id',conversationId).maybeSingle();check(error);return data?.bot_paused===true;
}
export async function notifyOwner(db:DatabaseClient,provider:WhatsAppProvider,e:Escalation,settings:OwnerSettings):Promise<boolean> {
  provider=meterWhatsApp(db,e.tenant_id,provider);
  const destination=ownerDestination(settings);
  if(!destination||!allowedRecipient(destination)) return false;
  // A business-line change must never turn notifications into self-chat.
  const me=readSessionIdentity((await provider.getSessionStatus(e.session)).me);
  if(!me.id || ownerIdentityField(destination,me) || ownerIdentityField(`${settings.owner_phone}@c.us`,me)) {
    console.warn('escalation_owner_identity_unavailable_or_self');return false;
  }
  if(!await claim(db,e,'queued','notifying')) return false;
  try {
    const id=await send(provider,e.session,destination,buildEscalationText(e.client_name,e.question,settings));
    await patch(db,e,{status:'pending',pending_since:new Date().toISOString(),owner_message_ids:[...new Set([...e.owner_message_ids,replyId(id)])]});
    return true;
  } catch {
    // Ambiguous network result: do not resend automatically and create duplicate questions.
    console.error('escalation_notification_uncertain',{tenantId:e.tenant_id,escalationId:e.id});
    throw new Error('Owner notification delivery uncertain');
  }
}
export async function createEscalation(db:DatabaseClient,provider:WhatsAppProvider,input:Omit<Escalation,'id'|'status'|'owner_message_ids'|'answer'|'learning_state'|'learning_message_ids'>,settings:OwnerSettings,clientZone?:string|null) {
  provider=meterWhatsApp(db,input.tenant_id,provider);
  if(!ownerDestination(settings)) {console.warn('webhook_escalation_skipped',{reason:'missing_owner_phone'});return;}
  if(!allowedRecipient(ownerDestination(settings))) return;
  const {data,error}=await db.from('escalations').insert(input).select('*').single();
  if(error?.code==='23505') return;
  check(error); if(!data) throw new Error('Escalation not created');
  const e=data as unknown as Escalation;
  const now=new Date(),quiet=isWithinQuietHours(settings,now);
  const scheduledAt=quiet?nextQuietHoursEnd(settings,now):now;
  const {error:jobError}=await db.from('scheduled_jobs').insert({tenant_id:e.tenant_id,job_type:JOB,payload:{escalation_id:e.id},scheduled_at:scheduledAt.toISOString(),status:'pending'});check(jobError);
  await send(provider,e.session,e.client_chat_id,waitingText(e.question,quiet?{at:scheduledAt,ownerZone:settings.time_zone??'UTC',clientZone:clientZone??null}:undefined,settings));
  if(!quiet) await notifyOwner(db,provider,e,settings);
}
async function requestLearning(db:DatabaseClient,provider:WhatsAppProvider,e:Escalation,from:string,settings:OwnerSettings) {
  const {data,error}=await db.from('escalations').update({learning_state:'prompting'}).eq('tenant_id',e.tenant_id).eq('id',e.id).eq('status','delivered').eq('learning_state','none').select('id');check(error);
  if(!data?.length) return;
  const id=await send(provider,e.session,from,renderText(settings,'owner.learning',behavior(settings).owner_language,{question:e.question,answer:e.answer??''}));
  await patch(db,e,{learning_state:'awaiting',learning_message_ids:[replyId(id)]});
}
export async function handleOwnerMessage(db:DatabaseClient,provider:WhatsAppProvider,tenantId:string,session:string,from:string,text:string,quoted:string|null,settings:OwnerSettings,ai?:AIProvider|null):Promise<boolean> {
  provider=meterWhatsApp(db,tenantId,provider);
  if(await pairOwner(db,tenantId,from,text,settings)) return true;
  if(!isBusinessOwner(from,settings)) return false;
  const command=text.trim().toLowerCase().replace(/[.!]+$/,'');
  if(['пауза всё','пауза все','продолжить всё','продолжить все'].includes(command)) {
    const paused=command.startsWith('пауза');
    const {error}=await db.from('notification_settings').update({auto_replies_paused:paused}).eq('tenant_id',tenantId);check(error);
    await send(provider,session,from,paused?renderText(settings,'owner.owner_reply_5',behavior(settings).owner_language):renderText(settings,'owner.owner_reply_6',behavior(settings).owner_language));return true;
  }
  if(command==='диалоги') {
    const result=await db.from('conversations').select('id,client_id,bot_paused').eq('tenant_id',tenantId).eq('status','active').order('last_message_at',{ascending:false}).limit(20);check(result.error);
    const lines:string[]=[];
    for(const conversation of result.data??[]) {
      const client=await db.from('clients').select('name').eq('tenant_id',tenantId).eq('id',conversation.client_id).maybeSingle();check(client.error);
      lines.push(renderText(settings,'owner.dialog_line',behavior(settings).owner_language,{name:client.data?.name||'',paused:conversation.bot_paused?' ⏸':'',id:conversation.id}));
    }
    await send(provider,session,from,lines.length?lines.join('\n\n'):renderText(settings,'owner.short_0',behavior(settings).owner_language));return true;
  }
  const direct=/^(пауза диалог|продолжить диалог|беру на себя) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(command);
  if(direct) {
    const paused=direct[1]!=='продолжить диалог';
    const result=await db.from('conversations').update({bot_paused:paused}).eq('tenant_id',tenantId).eq('id',direct[2]!).select('id');check(result.error);
    await send(provider,session,from,result.data?.length?(paused?renderText(settings,'owner.owner_reply_12',behavior(settings).owner_language):renderText(settings,'owner.short_1',behavior(settings).owner_language)):renderText(settings,'owner.short_2',behavior(settings).owner_language));return true;
  }
  if(!quoted) {await send(provider,session,from,renderText(settings,'owner.owner_reply_15',behavior(settings).owner_language));return true;}
  const key=replyId(quoted);
  const learning=await db.from('escalations').select('*').eq('tenant_id',tenantId).contains('learning_message_ids',[key]).limit(1);check(learning.error);
  const learned=learning.data?.[0] as Escalation|undefined;
  if(learned){
    if(learned.learning_state!=='awaiting') return true;
    if(['да','сохранить','yes','כן'].includes(command)){
      const {error}=await db.rpc('confirm_escalation_learning',{p_tenant_id:tenantId,p_escalation_id:learned.id});check(error);
      await send(provider,session,from,renderText(settings,'owner.short_3',behavior(settings).owner_language));
    }else if(['нет','no','לא'].includes(command)){await patch(db,learned,{learning_state:'declined'});}
    return true;
  }
  const found=await db.from('escalations').select('*').eq('tenant_id',tenantId).contains('owner_message_ids',[key]).limit(1);check(found.error);
  const e=found.data?.[0] as Escalation|undefined;
  if(!e) return true;
  if(['беру на себя','пауза','продолжить'].includes(command)) {
    const paused=command!=='продолжить';
    const {error}=await db.from('conversations').update({bot_paused:paused}).eq('tenant_id',tenantId).eq('id',e.conversation_id);check(error);
    await send(provider,session,from,paused?renderText(settings,'owner.owner_reply_22',behavior(settings).owner_language):renderText(settings,'owner.owner_reply_23',behavior(settings).owner_language));return true;
  }
  if(e.status==='delivered'){await requestLearning(db,provider,e,from,settings);return true;}
  if(e.status!=='pending') return true;
  if(isDeferredAnswer(text)) {await send(provider,session,from,renderText(settings,'owner.owner_reply_24',behavior(settings).owner_language));return true;}
  if(settings.auto_replies_paused||await conversationPaused(db,tenantId,e.conversation_id)){
    await send(provider,session,from,renderText(settings,'owner.owner_reply_25',behavior(settings).owner_language));return true;
  }
  const answer=clientText(text);if(!answer) return true;
  if(!allowedRecipient(e.client_chat_id)) return true;
  if(!await claim(db,e,'pending','delivering')) return true;
  await patch(db,e,{answer});
  try {
    const id=await send(provider,session,e.client_chat_id,ownerAnswerText(e.question,(settings.translate_owner_answer ?? BEHAVIOR_DEFAULTS.translate_owner_answer) ? await translateOwnerAnswer(e.question,answer,ai) : answer,settings));
    await patch(db,e,{status:'delivered',client_message_id:id,delivered_at:new Date().toISOString()});
  } catch {
    await patch(db,e,{status:'delivery_uncertain'});
    console.error('escalation_client_delivery_uncertain',{tenantId,escalationId:e.id});
    await send(provider,session,from,renderText(settings,'owner.owner_reply_26',behavior(settings).owner_language));return true;
  }
  await requestLearning(db,provider,{...e,answer},from,settings);
  return true;
}
export async function runDueScheduledEscalations(db:DatabaseClient,providerFor:()=>WhatsAppProvider,now=new Date(),tenantId?:string):Promise<number> {
  let jobs=db.from('scheduled_jobs').select('id,tenant_id,payload').eq('job_type',JOB).eq('status','pending').lte('scheduled_at',now.toISOString());if(tenantId)jobs=jobs.eq('tenant_id',tenantId);const {data,error}=await jobs.limit(50);check(error);
  let count=0;
  for(const job of data??[]){
    try{
      const found=await db.from('escalations').select('*').eq('tenant_id',job.tenant_id).eq('id',job.payload.escalation_id).maybeSingle();check(found.error);
      const e=found.data as Escalation|null;if(!e) continue;
      if(e.status==='queued'){
        const settings=await loadOwnerSettings(db,e.tenant_id);
        if(isWithinQuietHours(settings,now)) continue;
        if(!await notifyOwner(db,providerFor(),e,settings)) continue;
        count++;
      }
      const done=await db.from('scheduled_jobs').update({status:'done',executed_at:now.toISOString()}).eq('tenant_id',job.tenant_id).eq('id',job.id);check(done.error);
    }catch{console.error('escalation_queue_failed',{tenantId:job.tenant_id,jobId:job.id});}
  }
  return count;
}

export async function runEscalationTimeouts(db:DatabaseClient,providerFor:()=>WhatsAppProvider,now=new Date(),tenantId?:string){
 let pending=db.from('escalations').select('*').eq('status','pending');if(tenantId)pending=pending.eq('tenant_id',tenantId);const {data,error}=await pending;check(error);
 for(const row of data??[]){
  const e=row as Escalation;
  try{
   const settings=await loadOwnerSettings(db,e.tenant_id),config=behavior(settings);
   if(isWithinQuietHours(settings,now)||settings.auto_replies_paused||await conversationPaused(db,e.tenant_id,e.conversation_id))continue;
   const elapsed=activeElapsedMs(settings,new Date(e.pending_since??e.created_at!),now);
   const provider=meterWhatsApp(db,e.tenant_id,providerFor());
   if(elapsed>=config.escalation_close_minutes*60000){
    if(!await claim(db,e,'pending','closing'))continue;
    try{const id=await send(provider,e.session,e.client_chat_id,renderText(settings,'client.owner_timeout',/[א-ת]/.test(e.question)?'he':/[а-яё]/i.test(e.question)?'ru':'en'));
     await patch(db,e,{status:'closed_unanswered',closed_at:now.toISOString(),client_message_id:id});
    }catch{await patch(db,e,{status:'delivery_uncertain'});console.error('escalation_timeout_delivery_uncertain',{tenantId:e.tenant_id,escalationId:e.id});}
   }else if(!e.reminded_at&&elapsed>=config.escalation_remind_minutes*60000){
    const to=ownerDestination(settings),me=readSessionIdentity((await provider.getSessionStatus(e.session)).me);
    if(!to||!me.id||ownerIdentityField(to,me)||ownerIdentityField(`${settings.owner_phone}@c.us`,me))continue;
    if(!await claim(db,e,'pending','reminding'))continue;
    try{const id=await send(provider,e.session,to,renderText(settings,'owner.remind',config.owner_language,{name:e.client_name,question:e.question}));
     await patch(db,e,{status:'pending',reminded_at:now.toISOString(),owner_message_ids:[...e.owner_message_ids,replyId(id)]});
    }catch{await patch(db,e,{status:'pending',reminded_at:now.toISOString()});console.error('escalation_reminder_uncertain',{tenantId:e.tenant_id,escalationId:e.id});}
   }
  }catch{console.error('escalation_timeout_failed',{tenantId:e.tenant_id,escalationId:e.id});}
 }
}
