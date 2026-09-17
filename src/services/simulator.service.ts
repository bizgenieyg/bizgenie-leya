import { randomUUID } from 'node:crypto';
import { agentContext } from '../agents/index.js';
import { createAIProvider } from '../providers/ai/index.js';
import type { AIProvider } from '../providers/ai/ai-provider.interface.js';
import type { DatabaseClient } from '../db/supabase.js';
import { loadContext } from './context.service.js';
import { generateKnowledgeReply, generateReceptionReply } from './ai-fallback.service.js';
import { findExactKnowledgeAnswer } from './knowledge.service.js';
import { meterAI } from './metered-providers.js';
import { loadOwnerSettings } from './owner-settings.service.js';
import { routeConversation } from './conversation-routing.service.js';
import { languageOf, renderText } from './templates.service.js';
import { recordUsageEvent } from './usage.service.js';
import type { ConversationRow } from './tenant.service.js';
import { reserveSimulatorCall } from './simulator-rate-limit.js';
import {findSemanticKnowledge} from './semantic-knowledge.service.js';
import { HttpError } from '../utils/http-error.js';
import { behavior } from './runtime-settings.service.js';

export interface SimulationResult { reply:string; agent:string; source:'faq'|'model'|'reception'|'fallback'; }
type SimulatorSession={conversation:ConversationRow;messages:Array<{fromMe:boolean;text:string;createdAt:string}>;introduced:boolean;lastActive:number};
const simulatorSessions=new Map<string,SimulatorSession>();

function sessionFor(tenantId:string,sessionId:string,retentionHours:number,now:Date):SimulatorSession{
  const cutoff=now.getTime()-retentionHours*3600000;
  for(const [key,value] of simulatorSessions)if(value.lastActive<cutoff)simulatorSessions.delete(key);
  const key=`${tenantId}:${sessionId}`,existing=simulatorSessions.get(key);
  if(existing){existing.lastActive=now.getTime();return existing;}
  const created:SimulatorSession={conversation:{id:randomUUID(),tenant_id:tenantId,client_id:randomUUID(),status:'active',routed_agent:null,route_selected_at:null,source_label:null,reception_message_count:0,last_message_at:null} as ConversationRow,messages:[],introduced:false,lastActive:now.getTime()};
  simulatorSessions.set(key,created);return created;
}

function remember(session:SimulatorSession,fromMe:boolean,text:string,count:number,now:Date){
  session.messages.push({fromMe,text,createdAt:now.toISOString()});
  if(session.messages.length>count)session.messages.splice(0,session.messages.length-count);
  session.conversation.last_message_at=now.toISOString();session.lastActive=now.getTime();
}

export async function simulateCustomerMessage(db:DatabaseClient,tenantId:string,sessionId:string,text:string,ai:AIProvider|null=createAIProvider(),limitOptions?:{now?:Date;root?:string}):Promise<SimulationResult>{
  const [settings,context]=await Promise.all([loadOwnerSettings(db,tenantId),loadContext(db,tenantId)]);
  const config=behavior(settings),now=limitOptions?.now??new Date(),reservation=await reserveSimulatorCall(tenantId,config.simulator_hourly_limit,config.simulator_daily_limit,now,limitOptions?.root);
  if(!reservation.allowed)throw new HttpError(429,reservation.period==='hour'?'Simulator hourly limit reached':'Simulator daily limit reached',{code:reservation.period==='hour'?'simulator_hourly_limit':'simulator_daily_limit'});
  const session=sessionFor(tenantId,sessionId,config.context_retention_hours,now),history=[...session.messages];
  remember(session,false,text,config.context_message_count,now);
  const exact=findExactKnowledgeAnswer(text,context.knowledge);
  if(exact.matched){remember(session,true,exact.answer,config.context_message_count,now);session.introduced=true;return{reply:exact.answer,agent:'CORE',source:'faq'};}
  context.materials=await findSemanticKnowledge(db,tenantId,text);

  const classificationUsage:Record<string,unknown>[]=[];
  const route=await routeConversation(db,tenantId,session.conversation,text,settings,ai,usage=>classificationUsage.push(usage),history.length===0,false);
  for(const metadata of classificationUsage)await agentContext.run({agent:'RECEPTION'},()=>recordUsageEvent(db,{tenantId,eventType:'model_call',eventKey:randomUUID(),metadata:{...metadata,purpose:'intent_classification',simulation:true}}));

  if(route.kind==='agent')session.conversation.routed_agent=route.agent.name;
  else if(route.kind==='reception')session.conversation.routed_agent='RECEPTION';
  let result:SimulationResult;
  if(route.kind==='escalate')result={reply:renderText(settings,'client.reception_question',languageOf(text)),agent:'RECEPTION',source:'fallback'};
  else{
  const agent=route.kind==='agent'?route.agent.name:'RECEPTION';
  const model=meterAI(db,tenantId,ai,{simulation:true,purpose:'simulator_reply'});
  if(route.kind==='reception'){
    const prompt=renderText(settings,'client.reception_question',languageOf(text));
    const reception=await agentContext.run({agent},()=>generateReceptionReply(context,text,prompt,model,history,session.introduced));
    session.conversation.reception_message_count=Number(session.conversation.reception_message_count??0)+1;
    result={reply:reception.reply||prompt,agent,source:reception.reply?'reception':'fallback'};
  }else{
    const reply=await agentContext.run({agent},()=>generateKnowledgeReply(context,text,model,route.agent.systemPrompt,history,session.introduced));
    result={reply:reply||renderText(settings,'client.reception_question',languageOf(text)),agent,source:reply?'model':'fallback'};
  }
  }
  remember(session,true,result.reply,config.context_message_count,now);session.introduced=true;
  return result;
}
