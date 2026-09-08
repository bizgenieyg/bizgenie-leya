import { runUsageNotices } from "../services/usage-notifications.service.js";
import { supabase } from '../db/supabase.js';
import { createWhatsAppProvider } from '../providers/whatsapp/index.js';
import { runDueScheduledEscalations } from '../services/owner-workflow.service.js';
export function startEscalationScheduler() {
  let busy=false;
  const tick=async()=>{if(busy)return;busy=true;try{await runDueScheduledEscalations(supabase,createWhatsAppProvider);await runUsageNotices(supabase,createWhatsAppProvider);}catch{console.error('escalation_scheduler_failed');}finally{busy=false;}};
  const timer=setInterval(()=>{void tick();},60000);timer.unref();void tick();
  return ()=>clearInterval(timer);
}
