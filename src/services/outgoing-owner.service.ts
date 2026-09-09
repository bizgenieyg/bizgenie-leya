import type { DatabaseClient } from '../db/supabase.js';
import { extractMessageId } from '../providers/whatsapp/waha.provider.js';
import { senderKey } from '../utils/whatsapp-id.js';

const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};

/** Record a manual owner send before the normal incoming policy drops fromMe events. */
export async function observeOwnerOutgoing(db:DatabaseClient,tenantId:string,body:Record<string,unknown>,now=new Date()):Promise<boolean>{
  if(!['message','message.any'].includes(String(body.event)))return false;
  const payload=record(body.payload),info=record(record(payload._data).Info);
  if(payload.fromMe!==true&&info.IsFromMe!==true)return false;
  const chats=[info.Chat,payload.to,payload.from].filter((value,index,all)=>typeof value==='string'&&/^\d+@(lid|c\.us|s\.whatsapp\.net)$/.test(value)&&all.indexOf(value)===index) as string[];
  if(!chats.length)return false;
  const id=extractMessageId(payload.id);
  if(id){const known=await db.from('messages').select('id').eq('tenant_id',tenantId).eq('waha_msg_id',id).limit(1);if(known.error)throw new Error('Outgoing lookup failed');if(known.data?.length)return false;}
  // WAHA marks API-originated sends explicitly. Those are bot sends, not owner takeover.
  if(payload.source==='api')return false;
  let clientId:string|undefined,chatId:string|undefined;
  for(const chat of chats){const client=await db.from('clients').select('id').eq('tenant_id',tenantId).eq('phone',senderKey(chat)).maybeSingle();if(client.error)throw new Error('Outgoing client lookup failed');if(client.data){clientId=client.data.id;chatId=chat;break;}}
  if(!clientId||!chatId)return false;
  const conversation=await db.from('conversations').select('id').eq('tenant_id',tenantId).eq('client_id',clientId).eq('status','active').order('created_at',{ascending:false}).limit(1).maybeSingle();
  if(conversation.error)throw new Error('Outgoing conversation lookup failed');if(!conversation.data)return false;
  const at=now.toISOString();
  const paused=await db.from('conversations').update({bot_paused:true,owner_last_activity_at:at,last_message_at:at}).eq('tenant_id',tenantId).eq('id',conversation.data.id);
  if(paused.error)throw new Error('Outgoing pause failed');
  const text=typeof payload.body==='string'?payload.body:null;
  const stored=await db.from('messages').insert({conversation_id:conversation.data.id,tenant_id:tenantId,from_me:true,body:text,msg_type:text?'owner_text':'owner_media',waha_msg_id:id||null,raw_payload:body,created_at:at});
  if(stored.error)throw new Error('Outgoing persistence failed');
  const closed=await db.from('escalations').update({status:'resolved_by_owner',closed_at:at}).eq('tenant_id',tenantId).eq('conversation_id',conversation.data.id).in('status',['queued','notifying','pending','reminding','closing']);
  if(closed.error)throw new Error('Outgoing escalation closure failed');
  return true;
}
