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
import { enabledAgentNames, routeConversation } from './conversation-routing.service.js';
import { languageOf, renderText } from './templates.service.js';
import { recordUsageEvent } from './usage.service.js';
import type { ConversationRow } from './tenant.service.js';

export interface SimulationResult { reply:string; agent:string; source:'faq'|'model'|'reception'|'fallback'; }

export async function simulateCustomerMessage(db:DatabaseClient,tenantId:string,text:string,ai:AIProvider|null=createAIProvider()):Promise<SimulationResult>{
  const [settings,context]=await Promise.all([loadOwnerSettings(db,tenantId),loadContext(db,tenantId)]);
  const exact=findExactKnowledgeAnswer(text,context.knowledge);
  if(exact.matched)return{reply:exact.answer,agent:'CORE',source:'faq'};

  const conversation={id:`simulation-${randomUUID()}`,tenant_id:tenantId,client_id:'simulation',status:'active',routed_agent:null,route_selected_at:null,source_label:null,reception_message_count:0,last_message_at:null} as ConversationRow;
  const classificationUsage:Record<string,unknown>[]=[];
  const route=await routeConversation(db,tenantId,conversation,text,settings,ai,usage=>classificationUsage.push(usage),true,false);
  for(const metadata of classificationUsage)await agentContext.run({agent:'RECEPTION'},()=>recordUsageEvent(db,{tenantId,eventType:'model_call',eventKey:randomUUID(),metadata:{...metadata,purpose:'intent_classification',simulation:true}}));

  if(route.kind==='escalate')return{reply:renderText(settings,'client.reception_question',languageOf(text),{agents:enabledAgentNames(settings)}),agent:'RECEPTION',source:'fallback'};
  const agent=route.kind==='agent'?route.agent.name:'RECEPTION';
  const model=meterAI(db,tenantId,ai,{simulation:true,purpose:'simulator_reply'});
  if(route.kind==='reception'){
    const prompt=renderText(settings,'client.reception_question',languageOf(text),{agents:enabledAgentNames(settings)});
    const result=await agentContext.run({agent},()=>generateReceptionReply(context,text,prompt,model,[],false));
    return{reply:result.reply||prompt,agent,source:result.reply?'reception':'fallback'};
  }
  const reply=await agentContext.run({agent},()=>generateKnowledgeReply(context,text,model,route.agent.systemPrompt,[],false));
  return{reply:reply||renderText(settings,'client.reception_question',languageOf(text),{agents:enabledAgentNames(settings)}),agent,source:reply?'model':'fallback'};
}
