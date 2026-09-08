import type { DatabaseClient } from '../db/supabase.js';
import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { allowedRecipient,ownerIdentityField,readSessionIdentity } from '../utils/incoming-policy.js';
import { loadOwnerSettings,ownerDestination } from './owner-settings.service.js';
import { meterWhatsApp } from './metered-providers.js';

/** Service fallback is not a paid automatic answer; no Gemini call is needed. */
export function limitClientText(message:string):string {
  return /[א-ת]/.test(message)?'אני העוזרת של בעל העסק. כרגע המענה האוטומטי אינו זמין. בעל העסק יוכל לענות לך בהמשך.':/[а-яё]/i.test(message)?'Я ассистент владельца. Сейчас автоматические ответы недоступны. Владелец сможет ответить вам лично.':"I'm the owner's assistant. Automatic replies are currently unavailable. The owner can respond to you personally.";
}
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
      const resource=voice?'голосовых сообщений':'входящих сообщений';
      const used=voice?Number(job.payload.voice_seconds_used)/60:Number(job.payload.messages_used);
      const limit=voice?Number(job.payload.voice_seconds_limit)/60:Number(job.payload.messages_limit);
      const balance=` Расход: ${used.toLocaleString('ru',{maximumFractionDigits:2})} из ${limit.toLocaleString('ru',{maximumFractionDigits:2})}${voice?' мин.':' сообщений.'}`;
      const text=exhausted?`Лимит ${resource} не позволяет автоматически обработать новое сообщение. Клиентам показывается сообщение, что вы сможете ответить лично. Ответьте им вручную или обратитесь к администратору для изменения тарифа.`:`Использовано не менее 80% месячного лимита ${resource}. Обратитесь к администратору для изменения тарифа.`;
      try{
        const sent=await transport.sendMessage({session,chatId:to,text:text+balance});if(!sent.id)throw new Error('Missing message ID');
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
