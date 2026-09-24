import { env } from "../config/env.js";
import { supabase, type DatabaseClient } from "../db/supabase.js";
import { createWhatsAppProvider, type WhatsAppProvider } from "../providers/whatsapp/index.js";
import { HttpError } from "../utils/http-error.js";
import { enqueueMessage } from '../workers/outbound-queue.js';
import { sendPlatformAlert, safeAlertLabel, redactPhoneNumbers } from './platform-alerts.service.js';

export async function submitPlatformFeedback(
  tenantId: string,
  message: string,
  db: DatabaseClient = supabase,
  provider?: WhatsAppProvider,
  ownerChatId: string | undefined = env.platformOwnerWhatsAppNumber,
): Promise<{ saved: true }> {
  const { error } = await db.from("platform_feedback").insert({ tenant_id: tenantId, message });
  if (error) throw new HttpError(500, "Could not save feedback");

  // Telegram and WhatsApp are independent delivery channels. Every review is sent.
  try {
    const tenant = await db.from('tenants').select('business_name,name').eq('id', tenantId).maybeSingle();
    const businessName = safeAlertLabel(tenant.data?.business_name ?? tenant.data?.name ?? tenantId);
    await sendPlatformAlert('feedback', `Отзыв от ${businessName} (${tenantId}): ${redactPhoneNumbers(message).slice(0, 3500)}`, tenantId, { every: true });
  } catch { console.error('platform_feedback_telegram_failed', { tenantId }); }

  try {
    if (!ownerChatId || !/^\d{8,15}@c\.us$/.test(ownerChatId)) {
      throw new Error("platform owner WhatsApp number is not configured");
    }
    const [tenantResult, instanceResult] = await Promise.all([
      db.from("tenants").select("business_name,name").eq("id", tenantId).maybeSingle(),
      db.from("whatsapp_instances").select("session_name,status").eq("tenant_id", tenantId).maybeSingle(),
    ]);
    if (tenantResult.error || instanceResult.error || !instanceResult.data?.session_name || instanceResult.data.status !== "WORKING") {
      throw new Error("tenant WhatsApp session is unavailable");
    }
    const tenant = tenantResult.data as { business_name?: string | null; name?: string | null } | null;
    const businessName = tenant?.business_name || tenant?.name || tenantId;
    const transport = provider ?? createWhatsAppProvider();
    await enqueueMessage(db, tenantId, transport, {
      session: String(instanceResult.data.session_name),
      chatId: ownerChatId,
      text: `Отзыв от тенанта ${businessName} (${tenantId}): ${message}`,
    }, { kind: 'owner_notice' });
  } catch (notificationError) {
    console.error("platform_feedback_notification_failed", {
      tenantId,
      errorName: notificationError instanceof Error ? notificationError.name : "unknown",
    });
  }

  return { saved: true };
}
