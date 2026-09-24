import { AIProviderError } from "../providers/ai/ai-provider.interface.js";
import { randomUUID } from 'node:crypto';
import type { AIProvider } from '../providers/ai/ai-provider.interface.js';
import type { DatabaseClient } from '../db/supabase.js';
import { recordUsageEvent } from './usage.service.js';
const tenantMeter=Symbol('tenant-meter');
export function meterAI(db:DatabaseClient,tenantId:string,provider:AIProvider|null,metadata:Record<string,unknown>={}):AIProvider|null {
  if(!provider)return null;
  if((provider as AIProvider & {[tenantMeter]?:string})[tenantMeter]===tenantId)return provider;
  return { [tenantMeter]:tenantId, async generateReply(input){
    const eventKey=randomUUID();
    try{
      const result=await provider.generateReply(input);
      await recordUsageEvent(db,{tenantId,eventType:'model_call',eventKey,metadata:{...metadata,status:'success',...(result.usage??{})}});
      return result;
    }catch(error){await recordUsageEvent(db,{tenantId,eventType:'model_call',eventKey,metadata:{...metadata,status:'failed',...(error instanceof AIProviderError?error.usage??{}:{})}});throw error;}
  }} as AIProvider;
}
