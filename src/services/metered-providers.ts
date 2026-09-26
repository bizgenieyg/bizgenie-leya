import { AIProviderError, failureReason, MODEL_UNAVAILABLE, modelUnavailable } from "../providers/ai/ai-provider.interface.js";
import { randomUUID } from 'node:crypto';
import type { AIProvider } from '../providers/ai/ai-provider.interface.js';
import type { DatabaseClient } from '../db/supabase.js';
import { recordUsageEvent } from './usage.service.js';
const tenantMeter=Symbol('tenant-meter');
const meterSource=Symbol('meter-source');
type Metered=AIProvider&{[tenantMeter]?:string;[meterSource]?:{provider:AIProvider;metadata:Record<string,unknown>}};
/** Re-metering an already metered provider with new metadata (e.g. a purpose) wraps the raw provider once, never twice. */
export function meterAI(db:DatabaseClient,tenantId:string,provider:AIProvider|null,metadata:Record<string,unknown>={}):AIProvider|null {
  if(!provider)return null;
  const existing=provider as Metered;
  if(existing[tenantMeter]===tenantId){
    if(!Object.keys(metadata).length)return provider;
    const source=existing[meterSource]!;
    return meterAI(db,tenantId,source.provider,{...source.metadata,...metadata});
  }
  const wrapped:Metered={ [tenantMeter]:tenantId, [meterSource]:{provider,metadata}, ...(modelUnavailable(provider)?{[MODEL_UNAVAILABLE]:true}:{}), async generateReply(input){
    const eventKey=randomUUID();
    try{
      const result=await provider.generateReply(input);
      await recordUsageEvent(db,{tenantId,eventType:'model_call',eventKey,metadata:{...metadata,status:'success',...(result.usage??{})}});
      return result;
    }catch(error){await recordUsageEvent(db,{tenantId,eventType:'model_call',eventKey,metadata:{...metadata,status:'failed',failure_reason:failureReason(error),...(error instanceof AIProviderError?error.usage??{}:{})}});throw error;}
  }};
  return wrapped;
}
