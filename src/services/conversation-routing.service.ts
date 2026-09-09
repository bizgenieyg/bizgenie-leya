import type { DatabaseClient } from '../db/supabase.js';
import type { AIProvider } from '../providers/ai/ai-provider.interface.js';
import { registry } from '../agents/index.js';
import { behavior } from './runtime-settings.service.js';
import type { OwnerSettings } from './owner-settings.service.js';
import type { ConversationRow } from './tenant.service.js';

export type RouteOutcome={kind:'agent';agent:NonNullable<ReturnType<typeof registry.byName>>;method:string}|{kind:'reception';method:string}|{kind:'escalate';method:string};
const openStatuses=['queued','notifying','pending','reminding','delivering','delivery_uncertain','closing'];

export function entrySource(text:string):string|null{
 const url=/https?:\/\/\S+/i.exec(text)?.[0];
 if(url)try{const parsed=new URL(url),value=parsed.searchParams.get('utm_campaign')??parsed.searchParams.get('utm_source')??parsed.searchParams.get('campaign')??parsed.searchParams.get('source');if(value)return value.toLowerCase().slice(0,100);if(parsed.pathname.includes('/c/'))return'catalog';}catch{}
 return /\bкаталог\b|\bcatalog\b|קטלוג/i.test(text)?'catalog':null;
}
async function assign(db:DatabaseClient,tenantId:string,conversationId:string,agent:string,source?:string|null){const values:Record<string,unknown>={routed_agent:agent,route_selected_at:new Date().toISOString()};if(source)values.source_label=source;const r=await db.from('conversations').update(values).eq('tenant_id',tenantId).eq('id',conversationId);if(r.error)throw new Error('Conversation route save failed');}
async function unresolved(db:DatabaseClient,tenantId:string,conversationId:string,text:string){const r=await db.from('unrecognized_routes').insert({tenant_id:tenantId,conversation_id:conversationId,message_text:text});if(r.error)throw new Error('Unrecognized route save failed');}

export async function routeConversation(db:DatabaseClient,tenantId:string,conversation:ConversationRow,text:string,settings:OwnerSettings,ai:AIProvider|null,onModel?:(usage:Record<string,unknown>)=>void,isFirstMessage=false):Promise<RouteOutcome>{
 const config=behavior(settings),source=conversation.source_label??(isFirstMessage?entrySource(text):null);
 const configuredSource=config.source_routes.find((r:{source:string;agent:string})=>r.source.toLowerCase()===source)?.agent;
 const campaign=config.campaign_routes.find((r:{keyword:string;agent:string})=>text.toLowerCase().includes(r.keyword.toLowerCase()))?.agent;
 const forced=registry.byName(campaign??configuredSource??'',settings);if(forced){await assign(db,tenantId,conversation.id,forced.name,source);return{kind:'agent',agent:forced,method:campaign?'campaign':'source'};}
 const open=await db.from('escalations').select('id').eq('tenant_id',tenantId).eq('conversation_id',conversation.id).in('status',openStatuses).limit(1);if(open.error)throw new Error('Open case lookup failed');
 const support=open.data?.length?registry.byName('SUPPORT',settings):null;if(support){await assign(db,tenantId,conversation.id,support.name,source);return{kind:'agent',agent:support,method:'open_case'};}
 const cheap=await registry.classify(text,settings,null);if(cheap.agent&&cheap.method==='signal'&&cheap.agent.name!==conversation.routed_agent){await assign(db,tenantId,conversation.id,cheap.agent.name,source);return{kind:'agent',agent:cheap.agent,method:'signal_switch'};}
 const lastMessageAt=conversation.last_message_at?new Date(conversation.last_message_at).getTime():0;
 if(conversation.routed_agent&&conversation.routed_agent!=='RECEPTION'&&Date.now()-lastMessageAt<config.route_stickiness_hours*3600000){const sticky=registry.byName(conversation.routed_agent,settings);if(sticky)return{kind:'agent',agent:sticky,method:'sticky'};}
 if(cheap.agent){await assign(db,tenantId,conversation.id,cheap.agent.name,source);return{kind:'agent',agent:cheap.agent,method:'signal'};}
 const classified=await registry.classify(text,settings,ai,onModel,isFirstMessage?'Контекст: это новый контакт; считай его кандидатом SALE, но не назначай SALE без достаточной уверенности.':'');
 if(classified.agent&&classified.confidence>=config.intent_confidence_threshold){await assign(db,tenantId,conversation.id,classified.agent.name,source);return{kind:'agent',agent:classified.agent,method:'model'};}
 await unresolved(db,tenantId,conversation.id,text);
 if(conversation.reception_question_asked)return{kind:'escalate',method:'reception_exhausted'};
 await assign(db,tenantId,conversation.id,'RECEPTION',source);
 const marked=await db.from('conversations').update({reception_question_asked:true}).eq('tenant_id',tenantId).eq('id',conversation.id);if(marked.error)throw new Error('Reception state save failed');
 return{kind:'reception',method:'low_confidence'};
}
export function enabledAgentNames(settings:OwnerSettings){return registry.enabled(settings).map(a=>a.name).join(' / ');}
