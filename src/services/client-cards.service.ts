import type { DatabaseClient } from '../db/supabase.js';
import { HttpError } from '../utils/http-error.js';
import { isUuid } from './tenant.service.js';

const OPEN_ESCALATIONS=['queued','notifying','pending','reminding','delivering','delivery_uncertain','closing'];
export type ClientStatus='new'|'in_dialogue'|'waiting_owner'|'closed';
const fail=()=>{throw new HttpError(500,'Could not load client cards');};

export async function listClientCards(db:DatabaseClient,tenantId:string,search=''){
 let query=db.from('clients').select('id,phone,whatsapp_jid,name,language,notes,first_seen_at,last_seen_at,auto_reply_allowed,auto_reply_opted_out_at').eq('tenant_id',tenantId).order('last_seen_at',{ascending:false});
 const term=search.trim().replace(/[,%()]/g,'');if(term)query=query.or(`name.ilike.%${term}%,phone.ilike.%${term}%,whatsapp_jid.ilike.%${term}%`);
 const clients=await query;if(clients.error)fail();
 const ids=(clients.data??[]).map(row=>String(row.id));if(!ids.length)return [];
 const [conversations,escalations]=await Promise.all([
  db.from('conversations').select('id,client_id,status,routed_agent,last_message_at,created_at').eq('tenant_id',tenantId).in('client_id',ids).order('created_at',{ascending:false}),
  db.from('escalations').select('conversation_id,status').eq('tenant_id',tenantId).in('status',OPEN_ESCALATIONS),
 ]);if(conversations.error||escalations.error)fail();
 const conversationIds=(conversations.data??[]).map(row=>String(row.id));let inboundCounts=new Map<string,number>();
 if(conversationIds.length){const messages=await db.from('messages').select('conversation_id').eq('tenant_id',tenantId).eq('from_me',false).in('conversation_id',conversationIds);if(messages.error)fail();for(const row of messages.data??[]){const id=String(row.conversation_id);inboundCounts.set(id,(inboundCounts.get(id)??0)+1);}}
 const open=new Set((escalations.data??[]).map(row=>String(row.conversation_id)));
 return (clients.data??[]).map(client=>{
  const rows=(conversations.data??[]).filter(row=>row.client_id===client.id),current=rows[0];
  const status:ClientStatus=current&&open.has(String(current.id))?'waiting_owner':!current?'new':current.status==='active'?'in_dialogue':'closed';
  return {...client,phone:client.whatsapp_jid,inquiry_count:rows.reduce((sum,row)=>sum+(inboundCounts.get(String(row.id))??0),0),status,current_agent:current?.routed_agent??null,current_conversation_id:current?.id??null};
 });
}

export async function getClientCard(db:DatabaseClient,tenantId:string,clientId:string,messageLimit=20){
 if(!isUuid(clientId))throw new HttpError(400,'Invalid client id');
 const cards=await listClientCards(db,tenantId);const card=cards.find(row=>row.id===clientId);if(!card)throw new HttpError(404,'Client not found');
 const conversations=await db.from('conversations').select('id').eq('tenant_id',tenantId).eq('client_id',clientId).order('created_at',{ascending:false});if(conversations.error)fail();
 const ids=(conversations.data??[]).map(row=>String(row.id));let messages:any[]=[];
 if(ids.length){const result=await db.from('messages').select('id,conversation_id,from_me,body,msg_type,created_at').eq('tenant_id',tenantId).in('conversation_id',ids).order('created_at',{ascending:false}).limit(messageLimit);if(result.error)fail();messages=(result.data??[]).reverse();}
 return {...card,messages};
}

export async function updateClientCard(db:DatabaseClient,tenantId:string,clientId:string,input:Record<string,unknown>){
 if(!isUuid(clientId))throw new HttpError(400,'Invalid client id');
 const patch:Record<string,unknown>={};
 if('notes'in input){if(input.notes!==null&&typeof input.notes!=='string'||typeof input.notes==='string'&&input.notes.length>5000)throw new HttpError(400,'Invalid note');patch.notes=input.notes;}
 if('language'in input){if(!['he','ru','en'].includes(String(input.language)))throw new HttpError(400,'Invalid language');patch.language=input.language;patch.language_overridden=true;}
 if('auto_reply_allowed'in input){if(typeof input.auto_reply_allowed!=='boolean')throw new HttpError(400,'Invalid consent');patch.auto_reply_allowed=input.auto_reply_allowed;patch.auto_reply_opted_out_at=input.auto_reply_allowed?null:new Date().toISOString();}
 if(!Object.keys(patch).length)throw new HttpError(400,'No supported fields');
 const saved=await db.from('clients').update(patch).eq('tenant_id',tenantId).eq('id',clientId).select('id').maybeSingle();if(saved.error)fail();if(!saved.data)throw new HttpError(404,'Client not found');
 if(typeof input.auto_reply_allowed==='boolean'){const paused=await db.from('conversations').update({bot_paused:!input.auto_reply_allowed}).eq('tenant_id',tenantId).eq('client_id',clientId);if(paused.error)fail();}
 return getClientCard(db,tenantId,clientId);
}

export async function deleteClientCard(db:DatabaseClient,tenantId:string,clientId:string){if(!isUuid(clientId))throw new HttpError(400,'Invalid client id');const result=await db.from('clients').delete().eq('tenant_id',tenantId).eq('id',clientId).select('id');if(result.error)fail();if(!result.data?.length)throw new HttpError(404,'Client not found');}

export function inferredLanguage(text:string):'he'|'ru'|'en'{return /[א-ת]/.test(text)?'he':/[А-Яа-яЁё]/.test(text)?'ru':'en';}
export function requestsNoAutomaticReplies(text:string){const value=text.trim().toLowerCase();return /(?:не\s+(?:пиши|отвечай).*(?:бот|автомат)|отключи.*автоответ|stop\s+(?:automatic|bot)\s*(?:repl|messag)|do not.*(?:bot|automatic)|אל\s+תענה.*אוטומט|תפסיק.*אוטומט)/i.test(value);}
