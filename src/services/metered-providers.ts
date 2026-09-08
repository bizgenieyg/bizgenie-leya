import { AIProviderError } from "../providers/ai/ai-provider.interface.js";
import { randomUUID } from 'node:crypto';
import type { AIProvider } from '../providers/ai/ai-provider.interface.js';
import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import type { DatabaseClient } from '../db/supabase.js';
import { recordUsageEvent } from './usage.service.js';
const tenantMeter=Symbol('tenant-meter');
export function meterWhatsApp(db:DatabaseClient,tenantId:string,provider:WhatsAppProvider):WhatsAppProvider {
  if((provider as WhatsAppProvider & {[tenantMeter]?:string})[tenantMeter]===tenantId)return provider;
  return { [tenantMeter]:tenantId,
    getSessionStatus:provider.getSessionStatus.bind(provider),
    async sendMessage(input){
      const result=await provider.sendMessage(input);
      await recordUsageEvent(db,{tenantId,eventType:'message_sent',eventKey:result.id||randomUUID()});
      return result;
    },
  } as WhatsAppProvider;
}
export function meterAI(db:DatabaseClient,tenantId:string,provider:AIProvider|null):AIProvider|null {
  if(!provider)return null;
  if((provider as AIProvider & {[tenantMeter]?:string})[tenantMeter]===tenantId)return provider;
  return { [tenantMeter]:tenantId, async generateReply(input){
    const eventKey=randomUUID();
    try{
      const result=await provider.generateReply(input);
      await recordUsageEvent(db,{tenantId,eventType:'model_call',eventKey,metadata:{status:'success',...(result.usage??{})}});
      return result;
    }catch(error){await recordUsageEvent(db,{tenantId,eventType:'model_call',eventKey,metadata:{status:'failed',...(error instanceof AIProviderError?error.usage??{}:{})}});throw error;}
  }} as AIProvider;
}
