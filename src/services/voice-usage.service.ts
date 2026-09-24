import { randomUUID } from 'node:crypto';
import type { DatabaseClient } from '../db/supabase.js';
import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import type { STTProvider } from '../providers/stt/stt-provider.interface.js';
import { createSTTProvider } from '../providers/stt/index.js';
import { WahaMedia,type MediaProvider } from '../providers/media/waha-media.js';
import { findOrCreateClient,findOrCreateConversation,isTenantServiceable,type TenantRouting } from './tenant.service.js';
import { filterIncoming,allowedRecipient,ownerIdentityField,readSessionIdentity } from '../utils/incoming-policy.js';
import { loadOwnerSettings,isBusinessOwner } from './owner-settings.service.js';
import { recordUsageEvent,admitUsage } from './usage.service.js';
import { enqueueMessage } from '../workers/outbound-queue.js';
import { deliverUsageNotices,limitClientText,notifyUsageFailure } from './usage-notifications.service.js';
import { behavior } from './runtime-settings.service.js';
import { renderText } from './templates.service.js';
import { replyLanguage } from './templates.service.js';
import { agentContext } from '../agents/registry.js';
import { withoutRepeatedIntroduction } from '../utils/assistant-text.js';
import { conversationPaused } from './owner-workflow.service.js';
import { resolveClientPhone } from './client-phone.service.js';
import { sessionIdentity } from './session-identity.service.js';
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
export function voiceUsage(body:Record<string,unknown>):{from:string;seconds:number|null;id:string|null;mime:string;url:string}|null {
 const decision=filterIncoming(body);
 if(decision.allowed||!['non_text','missing_text'].includes(decision.reason))return null;
 const payload=object(body.payload),media=object(payload.media);
 if(typeof media.mimetype!=='string'||!media.mimetype.toLowerCase().startsWith('audio/')||typeof payload.from!=='string'||!allowedRecipient(payload.from))return null;
 const seconds=object(object(object(payload._data).Message).audioMessage).seconds;
 return {from:payload.from,seconds:typeof seconds==='number'&&Number.isFinite(seconds)&&seconds>=0?Math.ceil(seconds):null,id:typeof payload.id==='string'?payload.id:null,mime:media.mimetype.split(';')[0]!,url:typeof media.url==='string'?media.url:''};
}
export async function handleVoiceUsage(db:DatabaseClient,routing:TenantRouting,body:Record<string,unknown>,provider:WhatsAppProvider,stt:STTProvider|null=createSTTProvider(),media:MediaProvider=new WahaMedia(),
 onTranscript?: (textBody:Record<string,unknown>,admission:{key:string;seconds:number;unavailable?:boolean|undefined;sttKey:string;sttMetadata:Record<string,unknown>})=>Promise<void>):Promise<void>{
 const voice=voiceUsage(body);if(!voice||!isTenantServiceable(routing.tenant.status))return;
 const tenantId=routing.tenant.id,session=routing.instance?.session_name;if(!session)return;
 let me=readSessionIdentity(body.me);
 try{me={...me,...await sessionIdentity(provider,session)};}catch{return;}
 if(!me.id||ownerIdentityField(voice.from,me))return;
 const settings=await loadOwnerSettings(db,tenantId);if(isBusinessOwner(voice.from,settings))return;
 const key=voice.id??randomUUID(),config=behavior(settings);
 const client=await db.from('clients').select('id,language,language_overridden,auto_reply_allowed').eq('tenant_id',tenantId).eq('whatsapp_jid',voice.from).maybeSingle();if(client.error)return;
 if(client.data?.auto_reply_allowed===false){await recordUsageEvent(db,{tenantId,eventType:'message_observed',eventKey:key,metadata:{reason:'client_opt_out',billable:false,media:'voice'}});return;}
 let paused=settings.auto_replies_paused,conversationId:string|undefined,introduced=false;
 if(client.data){const c=await db.from('conversations').select('id,bot_paused,assistant_introduced_at').eq('tenant_id',tenantId).eq('client_id',client.data.id).eq('status','active').order('created_at',{ascending:false}).limit(1).maybeSingle();if(c.error)return;conversationId=c.data?.id;introduced=!!c.data?.assistant_introduced_at;if(conversationId)paused=paused||await conversationPaused(db,tenantId,conversationId,settings);}
 if(paused){
  if(!conversationId){const info=object(object(object(body.payload)._data).Info),name=typeof info.PushName==='string'?info.PushName:null;const row=await findOrCreateClient(db,tenantId,await resolveClientPhone(provider,session,voice.from,body,behavior(settings).lid_lookup_timeout_seconds),name,voice.from);conversationId=(await findOrCreateConversation(db,tenantId,row.id)).id;}
  const saved=await db.from('messages').insert({conversation_id:conversationId,tenant_id:tenantId,from_me:false,body:null,msg_type:'voice',waha_msg_id:voice.id,raw_payload:body});if(saved.error&&saved.error.code!=='23505')console.error('paused_voice_persist_failed',{tenantId});
  await recordUsageEvent(db,{tenantId,eventType:'message_observed',eventKey:key,metadata:{reason:'paused',billable:false,media:'voice',classified:true}});return;
 }
 return agentContext.run({agent:'RECEPTION'},async()=>{
  let language=client.data?.language_overridden&&client.data.language?String(client.data.language):String(client.data?.language??routing.tenant.language??'ru');
  const explain=async(template:string)=>{await enqueueMessage(db,tenantId,provider,{session,chatId:voice.from,text:withoutRepeatedIntroduction(renderText(settings,template,language),introduced)},{kind:'reply',dedupeKey:`voice:${key}:${template}`,inboundMessageIds:voice.id?[voice.id]:[]});if(conversationId&&!introduced){await db.from('conversations').update({assistant_introduced_at:new Date().toISOString()}).eq('tenant_id',tenantId).eq('id',conversationId).is('assistant_introduced_at',null);introduced=true;}};
  if(!stt){console.warn('stt_disabled_missing_key');await explain('client.voice_unavailable');return;}
  let bytes:Buffer|undefined;
  try{
   bytes=await media.download(voice.url,session,config.media_max_bytes,config.stt_timeout_seconds);
   // music-metadata is ESM-only; keep the native dynamic import in our
   // CommonJS build so requiring the webhook graph remains valid.
   const {parseBuffer}=await import('music-metadata');
   const duration=(await parseBuffer(bytes,{mimeType:voice.mime},{duration:true})).format.duration;
   if(!duration||!Number.isFinite(duration))throw new Error('Audio duration unavailable');
   const seconds=Math.ceil(duration);
   const admission=await admitUsage(db,tenantId,key,1,seconds);if(admission.duplicate)return;
   if(admission.unavailable)await notifyUsageFailure(db,tenantId,session,provider,settings);
   await deliverUsageNotices(db,tenantId,session,provider);
   if(!admission.allowed){await enqueueMessage(db,tenantId,provider,{session,chatId:voice.from,text:withoutRepeatedIntroduction(limitClientText(language==='he'?'שלום':language==='ru'?'Здравствуйте':'Hello',settings),introduced)},{kind:'reply',dedupeKey:`voice:${key}:limit`,inboundMessageIds:voice.id?[voice.id]:[]});if(conversationId&&!introduced){await db.from('conversations').update({assistant_introduced_at:new Date().toISOString()}).eq('tenant_id',tenantId).eq('id',conversationId).is('assistant_introduced_at',null);}return;}
   const sttKey=randomUUID();let result;
   try{result=await stt.transcribe(bytes,voice.mime,config.stt_timeout_seconds);}
   catch{await recordUsageEvent(db,{tenantId,eventType:'stt_call',eventKey:sttKey,metadata:{status:'failed'}});await recordUsageEvent(db,{tenantId,eventType:'message_received',eventKey:key});await recordUsageEvent(db,{tenantId,eventType:'voice_received',eventKey:key,quantity:seconds});await explain('client.voice_unavailable');return;}
   finally{bytes.fill(0);bytes=undefined;}
   const sttMetadata={status:'success',...result.usage};
   await recordUsageEvent(db,{tenantId,eventType:'stt_call',eventKey:sttKey,metadata:sttMetadata});
   await recordUsageEvent(db,{tenantId,eventType:'voice_received',eventKey:key,quantity:seconds});
   language=replyLanguage(result.text,{language:client.data?.language,language_overridden:client.data?.language_overridden});
   if(result.confidence<config.stt_confidence_threshold||result.ambiguous||!result.text.trim()){
    await recordUsageEvent(db,{tenantId,eventType:'message_received',eventKey:key});
    await explain('client.voice_clarify');return;
   }
   // Re-enter the same core using a text envelope. Keep identity and direction fields;
   // drop only media data now replaced by its transcript. No raw audio is persisted.
   const payload=object(body.payload),raw=object(payload._data);
   const textBody={...body,payload:{...payload,id:key,body:result.text,hasMedia:false,media:null,mediaUrl:null,location:null,vCards:[],_data:{...raw,Message:{conversation:result.text}}}};
   if(onTranscript){await onTranscript(textBody,{key,seconds,unavailable:admission.unavailable,sttKey,sttMetadata});return;}
   const {handleWebhookEvent}=await import('../workers/webhook.worker.js');
   await handleWebhookEvent(tenantId,textBody,db,provider,undefined,{key,seconds,unavailable:admission.unavailable,sttKey,sttMetadata});
  }catch{console.error('voice_processing_unavailable',{tenantId});await explain('client.voice_unavailable');}
  finally{bytes?.fill(0);}
 });
}
