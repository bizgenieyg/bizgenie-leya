import { SCHEDULER_POLL_MS } from '../config/behavior.js';
import { deliverUsageNotices } from '../services/usage-notifications.service.js';
import { supabase } from '../db/supabase.js';
import { createWhatsAppProvider } from '../providers/whatsapp/index.js';
import { runDueScheduledEscalations,runEscalationTimeouts } from '../services/owner-workflow.service.js';
import { loadOwnerSettings } from '../services/owner-settings.service.js';
import { behavior } from '../services/runtime-settings.service.js';
export function startEscalationScheduler() {
 let busy=false;const last=new Map<string,number>();
 const tick=async()=>{if(busy)return;busy=true;try{
  const {data,error}=await supabase.from('whatsapp_instances').select('tenant_id,session_name');if(error)throw error;
  for(const row of data??[]){
   const settings=await loadOwnerSettings(supabase,row.tenant_id),now=Date.now();
   if(now-(last.get(row.tenant_id)??0)<behavior(settings).scheduler_interval_seconds*1000)continue;
   last.set(row.tenant_id,now);
   await runDueScheduledEscalations(supabase,createWhatsAppProvider,new Date(now),row.tenant_id);
   await deliverUsageNotices(supabase,row.tenant_id,row.session_name,createWhatsAppProvider());
   await runEscalationTimeouts(supabase,createWhatsAppProvider,new Date(now),row.tenant_id);
  }
 }catch{console.error('escalation_scheduler_failed');}finally{busy=false;}};
 const timer=setInterval(()=>{void tick();},SCHEDULER_POLL_MS);timer.unref();void tick();return()=>clearInterval(timer);
}
