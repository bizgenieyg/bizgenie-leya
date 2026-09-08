import { BASIC_USAGE_LIMITS } from '../config/usage.js';
import { reserveFailureAlert } from './alert-throttle.js';
import { renderText,languageOf } from './templates.service.js';
import { behavior } from './runtime-settings.service.js';
import type { OwnerSettings } from './owner-settings.service.js';
import type { DatabaseClient } from '../db/supabase.js';
import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { allowedRecipient,ownerIdentityField,readSessionIdentity } from '../utils/incoming-policy.js';
import { loadOwnerSettings,ownerDestination } from './owner-settings.service.js';
import { meterWhatsApp } from './metered-providers.js';

/** Service fallback is not a paid automatic answer; no Gemini call is needed. */
export function limitClientText(message:string,settings?:OwnerSettings):string {return renderText(settings,'client.limit',languageOf(message));}
export async function deliverUsageNotices(db:DatabaseClient,tenantId:string,session:string,provider:WhatsAppProvider):Promise<void> {
  try {
    const {data:jobs,error}=await db.from('scheduled_jobs').select('id,payload').eq('tenant_id',tenantId).eq('job_type','usage_limit_notice').eq('status','pending').order('scheduled_at').limit(10);
    if(error)throw new Error('Usage notices unavailable');if(!jobs?.length)return;
    const settings=await loadOwnerSettings(db,tenantId);const to=ownerDestination(settings);
    if(!to||!allowedRecipient(to))return;
    const me=readSessionIdentity((await provider.getSessionStatus(session)).me);
    if(!me.id||ownerIdentityField(to,me)||ownerIdentityField(`${settings.owner_phone}@c.us`,me))return;
    const transport=meterWhatsApp(db,tenantId,provider);
    for(const job of jobs){
      const {data,error:claimError}=await db.from('scheduled_jobs').update({status:'sending'}).eq('tenant_id',tenantId).eq('id',job.id).eq('status','pending').select('id');
      if(claimError)throw new Error('Usage notice claim failed');if(!data?.length)continue;
      const voice=String(job.payload.stage).startsWith('voice');const exhausted=String(job.payload.stage).endsWith('100');
      const resource=renderText(settings,voice?'owner.resource_voice':'owner.resource_messages',behavior(settings).owner_language);
      const used=voice?Number(job.payload.voice_seconds_used)/60:Number(job.payload.messages_used);
      const limit=voice?Number(job.payload.voice_seconds_limit)/60:Number(job.payload.messages_limit);
      const text=renderText(settings,exhausted?'owner.usage_exhausted':'owner.usage_warning',behavior(settings).owner_language,{percent:Number(job.payload.warning_percent??BASIC_USAGE_LIMITS.warningPercent),resource,used,limit});
      try{
        const sent=await transport.sendMessage({session,chatId:to,text});if(!sent.id)throw new Error('Missing message ID');
        const done=await db.from('scheduled_jobs').update({status:'done',executed_at:new Date().toISOString()}).eq('tenant_id',tenantId).eq('id',job.id);if(done.error)throw new Error('Notice state failed');
      }catch{
        // Do not retry ambiguous transport sends automatically: avoid notification spam.
        await db.from('scheduled_jobs').update({status:'error',error:'usage_notice_delivery_uncertain'}).eq('tenant_id',tenantId).eq('id',job.id);
        console.error('usage_notice_delivery_failed',{tenantId,jobId:job.id});
      }
    }
  }catch{console.error('usage_notice_failed',{tenantId});}
}
export async function runUsageNotices(db:DatabaseClient,providerFor:()=>WhatsAppProvider):Promise<void> {
  try{
    const {data,error}=await db.from('scheduled_jobs').select('tenant_id').eq('job_type','usage_limit_notice').eq('status','pending').limit(100);if(error)throw new Error('Usage notice queue failed');
    for(const tenantId of new Set((data??[]).map(row=>String(row.tenant_id)))){
      const instance=await db.from('whatsapp_instances').select('session_name').eq('tenant_id',tenantId).maybeSingle();
      if(instance.data?.session_name)await deliverUsageNotices(db,tenantId,instance.data.session_name,providerFor());
    }
  }catch{console.error('usage_notice_scheduler_failed');}
}

export async function notifyUsageFailure(db:DatabaseClient,tenantId:string,session:string,provider:WhatsAppProvider,settings:OwnerSettings,now=Date.now()){
 console.error('usage_admission_unavailable',{tenantId});
 const interval=behavior(settings).usage_failure_alert_minutes*60000;
 try{
  if(!await reserveFailureAlert(tenantId,interval,now))return;
  const to=ownerDestination(settings);if(!to||!allowedRecipient(to))return;
  const me=readSessionIdentity((await provider.getSessionStatus(session)).me);
  if(!me.id||ownerIdentityField(to,me)||ownerIdentityField(`${settings.owner_phone}@c.us`,me))return;
  await meterWhatsApp(db,tenantId,provider).sendMessage({session,chatId:to,text:renderText(settings,'owner.usage_failure',behavior(settings).owner_language)});
 }catch{console.error('usage_failure_alert_delivery_failed',{tenantId});}
}
