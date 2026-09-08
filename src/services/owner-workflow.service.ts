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
  const destination=ownerDestination(settings);
  if(!destination||!allowedRecipient(destination)) return false;
  // A business-line change must never turn notifications into self-chat.
  const me=readSessionIdentity((await provider.getSessionStatus(e.session)).me);
  if(!me.id || ownerIdentityField(destination,me) || ownerIdentityField(`${settings.owner_phone}@c.us`,me)) {
    console.warn('escalation_owner_identity_unavailable_or_self');return false;
  }
  if(!await claim(db,e,'queued','notifying')) return false;
  try {
    const id=await send(provider,e.session,destination,buildEscalationText(e.client_name,e.question));
    await patch(db,e,{status:'pending',owner_message_ids:[...new Set([...e.owner_message_ids,replyId(id)])]});
    return true;
  } catch {
    // Ambiguous network result: do not resend automatically and create duplicate questions.
    console.error('escalation_notification_uncertain',{tenantId:e.tenant_id,escalationId:e.id});
    throw new Error('Owner notification delivery uncertain');
  }
}
export async function createEscalation(db:DatabaseClient,provider:WhatsAppProvider,input:Omit<Escalation,'id'|'status'|'owner_message_ids'|'answer'|'learning_state'|'learning_message_ids'>,settings:OwnerSettings,clientZone?:string|null) {
  if(!ownerDestination(settings)) {console.warn('webhook_escalation_skipped',{reason:'missing_owner_phone'});return;}
  if(!allowedRecipient(ownerDestination(settings))) return;
  const {data,error}=await db.from('escalations').insert(input).select('*').single();
  if(error?.code==='23505') return;
  check(error); if(!data) throw new Error('Escalation not created');
  const e=data as unknown as Escalation;
  const now=new Date(),quiet=isWithinQuietHours(settings,now);
  const scheduledAt=quiet?nextQuietHoursEnd(settings,now):now;
  const {error:jobError}=await db.from('scheduled_jobs').insert({tenant_id:e.tenant_id,job_type:JOB,payload:{escalation_id:e.id},scheduled_at:scheduledAt.toISOString(),status:'pending'});check(jobError);
  await send(provider,e.session,e.client_chat_id,waitingText(e.question,quiet?{at:scheduledAt,ownerZone:settings.time_zone??'UTC',clientZone:clientZone??null}:undefined));
  if(!quiet) await notifyOwner(db,provider,e,settings);
}
async function requestLearning(db:DatabaseClient,provider:WhatsAppProvider,e:Escalation,from:string) {
  const {data,error}=await db.from('escalations').update({learning_state:'prompting'}).eq('tenant_id',e.tenant_id).eq('id',e.id).eq('status','delivered').eq('learning_state','none').select('id');check(error);
  if(!data?.length) return;
  const id=await send(provider,e.session,from,`Ответ отправлен клиенту. Сохранить эту пару в базу знаний?\n\nВопрос: ${e.question}\nОтвет: ${e.answer ?? ''}\n\nОтветьте реплеем на это сообщение: «Да» или «Нет».`);
  await patch(db,e,{learning_state:'awaiting',learning_message_ids:[replyId(id)]});
}
export async function handleOwnerMessage(db:DatabaseClient,provider:WhatsAppProvider,tenantId:string,session:string,from:string,text:string,quoted:string|null,settings:OwnerSettings,ai?:AIProvider|null):Promise<boolean> {
  if(await pairOwner(db,tenantId,from,text,settings)) return true;
  if(!isBusinessOwner(from,settings)) return false;
  const command=text.trim().toLowerCase().replace(/[.!]+$/,'');
  if(['пауза всё','пауза все','продолжить всё','продолжить все'].includes(command)) {
    const paused=command.startsWith('пауза');
    const {error}=await db.from('notification_settings').update({auto_replies_paused:paused}).eq('tenant_id',tenantId);check(error);
    await send(provider,session,from,paused?'Автоответы бизнеса приостановлены. Для возобновления напишите «Продолжить всё».':'Автоответы бизнеса возобновлены. Диалоги, взятые вручную, остаются на паузе.');return true;
  }
  if(command==='диалоги') {
    const result=await db.from('conversations').select('id,client_id,bot_paused').eq('tenant_id',tenantId).eq('status','active').order('last_message_at',{ascending:false}).limit(20);check(result.error);
    const lines:string[]=[];
    for(const conversation of result.data??[]) {
      const client=await db.from('clients').select('name').eq('tenant_id',tenantId).eq('id',conversation.client_id).maybeSingle();check(client.error);
      lines.push(`${client.data?.name || 'Клиент'}${conversation.bot_paused?' — пауза':''}\nПауза диалог ${conversation.id}\nПродолжить диалог ${conversation.id}`);
    }
    await send(provider,session,from,lines.length?lines.join('\n\n'):'Активных диалогов пока нет.');return true;
  }
  const direct=/^(пауза диалог|продолжить диалог|беру на себя) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(command);
  if(direct) {
    const paused=direct[1]!=='продолжить диалог';
    const result=await db.from('conversations').update({bot_paused:paused}).eq('tenant_id',tenantId).eq('id',direct[2]!).select('id');check(result.error);
    await send(provider,session,from,result.data?.length?(paused?'Диалог на паузе до явного возобновления.':'Автоответы диалога возобновлены.'):'Диалог не найден в этом бизнесе.');return true;
  }
  if(!quoted) {await send(provider,session,from,'Ответьте реплеем на вопрос клиента. «Диалоги» — список диалогов и команд управления. Команды: «Пауза всё», «Продолжить всё»; реплеем на вопрос — «Беру на себя», «Пауза», «Продолжить».');return true;}
  const key=replyId(quoted);
  const learning=await db.from('escalations').select('*').eq('tenant_id',tenantId).contains('learning_message_ids',[key]).limit(1);check(learning.error);
  const learned=learning.data?.[0] as Escalation|undefined;
  if(learned){
    if(learned.learning_state!=='awaiting') return true;
    if(['да','сохранить','yes','כן'].includes(command)){
      const {error}=await db.rpc('confirm_escalation_learning',{p_tenant_id:tenantId,p_escalation_id:learned.id});check(error);
      await send(provider,session,from,'Ответ сохранён в базе знаний.');
    }else if(['нет','no','לא'].includes(command)){await patch(db,learned,{learning_state:'declined'});}
    return true;
  }
  const found=await db.from('escalations').select('*').eq('tenant_id',tenantId).contains('owner_message_ids',[key]).limit(1);check(found.error);
  const e=found.data?.[0] as Escalation|undefined;
  if(!e) return true;
  if(['беру на себя','пауза','продолжить'].includes(command)) {
    const paused=command!=='продолжить';
    const {error}=await db.from('conversations').update({bot_paused:paused}).eq('tenant_id',tenantId).eq('id',e.conversation_id);check(error);
    await send(provider,session,from,paused?'Автоответы в этом диалоге остановлены. Для возобновления ответьте «Продолжить» реплеем на вопрос.':'Автоответы в этом диалоге возобновлены.');return true;
  }
  if(e.status==='delivered'){await requestLearning(db,provider,e,from);return true;}
  if(e.status!=='pending') return true;
  if(isDeferredAnswer(text)) {await send(provider,session,from,'Вопрос остаётся открытым. Когда будет ответ по существу, отправьте его реплеем на тот же вопрос.');return true;}
  if(settings.auto_replies_paused||await conversationPaused(db,tenantId,e.conversation_id)){
    await send(provider,session,from,'Диалог на паузе. Возобновите автоответы и отправьте ответ ещё раз реплеем на вопрос. Обращение остаётся открытым.');return true;
  }
  const answer=clientText(text);if(!answer) return true;
  if(!allowedRecipient(e.client_chat_id)) return true;
  if(!await claim(db,e,'pending','delivering')) return true;
  await patch(db,e,{answer});
  try {
    const id=await send(provider,session,e.client_chat_id,ownerAnswerText(e.question,await translateOwnerAnswer(e.question,answer,ai)));
    await patch(db,e,{status:'delivered',client_message_id:id,delivered_at:new Date().toISOString()});
  } catch {
    await patch(db,e,{status:'delivery_uncertain'});
    console.error('escalation_client_delivery_uncertain',{tenantId,escalationId:e.id});
    await send(provider,session,from,'Доставка ответа клиенту не подтверждена. Обращение не закрыто; нужна проверка доставки.');return true;
  }
  await requestLearning(db,provider,{...e,answer},from);
  return true;
}
export async function runDueScheduledEscalations(db:DatabaseClient,providerFor:()=>WhatsAppProvider,now=new Date()):Promise<number> {
  const {data,error}=await db.from('scheduled_jobs').select('id,tenant_id,payload').eq('job_type',JOB).eq('status','pending').lte('scheduled_at',now.toISOString()).limit(50);check(error);
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
