import { randomUUID } from 'node:crypto';
import type { DatabaseClient } from '../db/supabase.js';
import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { isTenantServiceable } from './tenant.service.js';
import { senderKey } from '../utils/whatsapp-id.js';
import type { TenantRouting } from './tenant.service.js';
import { filterIncoming,allowedRecipient,ownerIdentityField,readSessionIdentity } from '../utils/incoming-policy.js';
import { loadOwnerSettings,isBusinessOwner } from './owner-settings.service.js';
import { recordUsageEvent,admitUsage } from './usage.service.js';
import { meterWhatsApp } from './metered-providers.js';
import { deliverUsageNotices,limitClientText } from './usage-notifications.service.js';
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
/** GOWS keeps the WAProto AudioMessage in payload._data.Message.audioMessage. */
export function voiceUsage(body:Record<string,unknown>):{from:string;seconds:number|null;id:string|null}|null {
  const decision=filterIncoming(body);
  if(decision.allowed||!['non_text','missing_text'].includes(decision.reason))return null;
  const payload=object(body.payload),audio=object(object(object(payload._data).Message).audioMessage);
  if(!Object.keys(audio).length||typeof payload.from!=='string'||!allowedRecipient(payload.from))return null;
  const seconds=audio.seconds;
  return {from:payload.from,seconds:typeof seconds==='number'&&Number.isFinite(seconds)&&seconds>=0&&seconds<=2147483647?Math.ceil(seconds):null,id:typeof payload.id==='string'?payload.id:null};
}
/** Meter private incoming audio without enabling speech recognition or bypassing text filters. */
export async function handleVoiceUsage(db:DatabaseClient,routing:TenantRouting,body:Record<string,unknown>,provider:WhatsAppProvider):Promise<void> {
  const voice=voiceUsage(body);if(!voice||!isTenantServiceable(routing.tenant.status))return;
  const tenantId=routing.tenant.id,session=routing.instance?.session_name;if(!session)return;
  let me=readSessionIdentity(body.me);
  try{me={...me,...readSessionIdentity((await provider.getSessionStatus(session)).me)};}catch{return;}
  if(!me.id||ownerIdentityField(voice.from,me))return;
  const settings=await loadOwnerSettings(db,tenantId);
  if(isBusinessOwner(voice.from,settings))return;
  const key=voice.id??randomUUID();
  await recordUsageEvent(db,{tenantId,eventType:'message_received',eventKey:key,metadata:{media:'voice'}});
  await recordUsageEvent(db,{tenantId,eventType:'voice_received',eventKey:key,quantity:voice.seconds??0,metadata:{duration_known:voice.seconds!==null,transcribed:false}});
  // Phase 1 does not transcribe audio. Record observed seconds and enforce reception quota.
  if(settings.auto_replies_paused)return;
  const client=await db.from('clients').select('id').eq('tenant_id',tenantId).eq('phone',senderKey(voice.from)).maybeSingle();
  if(client.error)return;
  if(client.data){const conversation=await db.from('conversations').select('bot_paused').eq('tenant_id',tenantId).eq('client_id',client.data.id).eq('status','active').order('created_at',{ascending:false}).limit(1).maybeSingle();if(conversation.error||conversation.data?.bot_paused)return;}

  const admission=await admitUsage(db,tenantId,key,1,voice.seconds??0);if(admission.duplicate)return;
  const transport=meterWhatsApp(db,tenantId,provider);
  await deliverUsageNotices(db,tenantId,session,transport);
  const language=routing.tenant.language??'ru';
  const sample=language==='he'?'שלום':language==='en'?'Hello':'Здравствуйте';
  const text=!admission.allowed?limitClientText(sample):language==='he'?'אני העוזרת של בעל העסק. כרגע אוכל לקרוא רק טקסט. אפשר לכתוב את השאלה או להמתין למענה מבעל העסק.':language==='en'?"I'm the owner's assistant. I can currently read text only. Please type your question or wait for the owner to respond.":'Я ассистент владельца. Сейчас могу прочитать только текст. Напишите вопрос сообщением или дождитесь ответа владельца.';
  await transport.sendMessage({session,chatId:voice.from,text});
}
