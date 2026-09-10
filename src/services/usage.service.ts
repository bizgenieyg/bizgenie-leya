import { agentContext } from '../agents/registry.js';
import type { DatabaseClient } from '../db/supabase.js';
import { logSystemEvent } from './logging.service.js';
export async function recordUsageEvent(db:DatabaseClient,input:{tenantId:string;eventType:string;quantity?:number;eventKey?:string;metadata?:Record<string,unknown>}):Promise<void> {
  try {
    const {error}=await db.from('usage_events').insert({tenant_id:input.tenantId,event_type:input.eventType,quantity:input.quantity??1,
      ...(input.eventKey?{event_key:input.eventKey}:{}),agent:agentContext.getStore()?.agent??'CORE',metadata:input.metadata??{}});
    if(error&&error.code!=='23505')console.error('usage_event_write_failed',{eventType:input.eventType});
  }catch{console.error('usage_event_write_failed',{eventType:input.eventType});}
}
export interface UsageAdmission {allowed:boolean;duplicate:boolean;unavailable?:boolean;}
export async function admitUsage(db:DatabaseClient,tenantId:string,eventKey:string,messages=1,voiceSeconds=0):Promise<UsageAdmission> {
  try {
    const {data,error}=await db.rpc('admit_tenant_usage',{p_tenant_id:tenantId,p_event_key:eventKey,p_messages:messages,p_voice_seconds:voiceSeconds,p_default_messages:0,p_default_voice_seconds:0,p_default_warning_percent:0});
    if(error||typeof data?.allowed!=='boolean'){
      if(typeof error?.message==='string'&&error.message.includes('CRITICAL: tenant plan integrity violation')){
        console.error('critical_tenant_plan_integrity_violation',{tenantId});
        try{await logSystemEvent(db,{tenantId,level:'error',event:'tenant_plan_integrity_violation'});}catch{}
      }
      throw new Error('Usage admission unavailable');
    }
    return data as UsageAdmission;
  }catch{
    // Preserve existing message processing if metering storage is unavailable.
    console.error('usage_admission_unavailable',{tenantId});
    try{await logSystemEvent(db,{tenantId,level:'error',event:'usage_admission_unavailable',details:{mode:'fail_open'}});}catch{console.error('usage_admission_system_log_failed',{tenantId});}
    return {allowed:true,duplicate:false,unavailable:true};
  }
}
export async function usageSummary(db:DatabaseClient,tenantId:string){
  const {data,error}=await db.rpc('tenant_usage_summary',{p_tenant_id:tenantId,p_default_messages:0,p_default_voice_seconds:0});
  if(error)throw new Error('Usage summary unavailable');return data;
}
