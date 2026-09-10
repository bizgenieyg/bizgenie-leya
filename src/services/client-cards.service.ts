import type { DatabaseClient } from '../db/supabase.js';
import { HttpError } from '../utils/http-error.js';
import { isUuid } from './tenant.service.js';

const CLIENT_COLUMNS='id,phone,whatsapp_jid,name,language,notes,first_seen_at,last_seen_at,auto_reply_allowed,auto_reply_opted_out_at';
const fail=()=>{throw new HttpError(500,'Could not load client cards');};
type CardStat={client_id:string;inquiry_count:number;current_conversation_id:string|null;current_status:'new'|'in_dialogue'|'waiting_owner'|'closed';current_agent:string|null};

async function stats(db:DatabaseClient,tenantId:string,clientId:string|null=null):Promise<Map<string,CardStat>>{
 const result=await db.rpc('client_card_stats',{p_tenant_id:tenantId,p_client_id:clientId});if(result.error)fail();
 return new Map((result.data??[]).map((row:any)=>[String(row.client_id),{...row,inquiry_count:Number(row.inquiry_count??0)}]));
}
function card(row:any,stat?:CardStat){return{...row,phone:row.whatsapp_jid,inquiry_count:stat?.inquiry_count??0,status:stat?.current_status??'new',current_agent:stat?.current_agent??null,current_conversation_id:stat?.current_conversation_id??null};}

export async function listClientCards(db:DatabaseClient,tenantId:string,search=''){
 let query=db.from('clients').select(CLIENT_COLUMNS).eq('tenant_id',tenantId).is('deleted_at',null).order('last_seen_at',{ascending:false});
 const term=search.trim().replace(/[,%()]/g,'');if(term)query=query.or(`name.ilike.%${term}%,phone.ilike.%${term}%,whatsapp_jid.ilike.%${term}%`);
 const clients=await query;if(clients.error)fail();const byClient=await stats(db,tenantId);return(clients.data??[]).map(row=>card(row,byClient.get(String(row.id))));
}

export async function getClientCard(db:DatabaseClient,tenantId:string,clientId:string,messageLimit=20){
 if(!isUuid(clientId))throw new HttpError(400,'Invalid client id');
 const [client,byClient,recent]=await Promise.all([db.from('clients').select(CLIENT_COLUMNS).eq('tenant_id',tenantId).eq('id',clientId).is('deleted_at',null).maybeSingle(),stats(db,tenantId,clientId),db.rpc('client_recent_messages',{p_tenant_id:tenantId,p_client_id:clientId,p_limit:messageLimit})]);if(client.error||recent.error)fail();if(!client.data)throw new HttpError(404,'Client not found');const messages=(recent.data??[]).reverse();
 return{...card(client.data,byClient.get(clientId)),messages};
}

export async function updateClientCard(db:DatabaseClient,tenantId:string,clientId:string,input:Record<string,unknown>){
 if(!isUuid(clientId))throw new HttpError(400,'Invalid client id');const patch:Record<string,unknown>={};
 if('notes'in input){if(input.notes!==null&&typeof input.notes!=='string'||typeof input.notes==='string'&&input.notes.length>5000)throw new HttpError(400,'Invalid note');patch.notes=input.notes;}
 if('language'in input){if(!['he','ru','en'].includes(String(input.language)))throw new HttpError(400,'Invalid language');patch.language=input.language;patch.language_overridden=true;}
 if('auto_reply_allowed'in input){if(typeof input.auto_reply_allowed!=='boolean')throw new HttpError(400,'Invalid consent');patch.auto_reply_allowed=input.auto_reply_allowed;patch.auto_reply_opted_out_at=input.auto_reply_allowed?null:new Date().toISOString();}
 if(!Object.keys(patch).length)throw new HttpError(400,'No supported fields');const saved=await db.from('clients').update(patch).eq('tenant_id',tenantId).eq('id',clientId).is('deleted_at',null).select('id').maybeSingle();if(saved.error)fail();if(!saved.data)throw new HttpError(404,'Client not found');
 if(typeof input.auto_reply_allowed==='boolean'){const paused=await db.from('conversations').update({bot_paused:!input.auto_reply_allowed}).eq('tenant_id',tenantId).eq('client_id',clientId);if(paused.error)fail();}return getClientCard(db,tenantId,clientId);
}

export async function deleteClientCard(db:DatabaseClient,tenantId:string,clientId:string,permanent=false){
 if(!isUuid(clientId))throw new HttpError(400,'Invalid client id');const query=permanent?db.from('clients').delete():db.from('clients').update({deleted_at:new Date().toISOString()});const result=await query.eq('tenant_id',tenantId).eq('id',clientId).select('id');if(result.error)fail();if(!result.data?.length)throw new HttpError(404,'Client not found');
}
export function inferredLanguage(text:string):'he'|'ru'|'en'{return /[א-ת]/.test(text)?'he':/[А-Яа-яЁё]/.test(text)?'ru':'en';}
export function requestsNoAutomaticReplies(text:string){const value=text.trim().toLowerCase();return /(?:не\s+(?:пиши|отвечай).*(?:бот|автомат)|отключи.*автоответ|stop\s+(?:automatic|bot)\s*(?:repl|messag)|do not.*(?:bot|automatic)|אל\s+תענה.*אוטומט|תפסיק.*אוטומט)/i.test(value);}
