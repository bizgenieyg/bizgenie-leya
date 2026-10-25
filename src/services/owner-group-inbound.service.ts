import type { DatabaseClient } from '../db/supabase.js';
import { createAIProvider } from '../providers/ai/index.js';
import { createWhatsAppProvider } from '../providers/whatsapp/index.js';
import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { meterAI } from './metered-providers.js';
import { ownerGroupMessage } from './owner-channels.service.js';
import { handleOwnerMessage } from './owner-workflow.service.js';
import { isOwnQueuedSend } from './outgoing-owner.service.js';
import { loadOwnerSettings } from './owner-settings.service.js';
import { getTenantRouting } from './tenant.service.js';
import { recordUsageEvent } from './usage.service.js';

/**
 * Z10: the owner writes in a «Нужен ответ» / «Отчёты» group — handled exactly like the owner's private messages
 * (a quoted answer reaches the client, commands, interview answers); replies go back to that group.
 * Returns true when the message was the owner's in an owner group.
 */
export async function handleOwnerGroupMessage(db: DatabaseClient, tenantId: string, body: Record<string, unknown>,
  whatsapp?: WhatsAppProvider): Promise<boolean> {
  const message = await ownerGroupMessage(db, tenantId, body, (id, chat, text) => isOwnQueuedSend(db, tenantId, id, [chat], text, new Date()));
  if (!message) return false;
  const routing = await getTenantRouting(db, tenantId);
  const session = typeof routing?.instance?.session_name === 'string' ? routing.instance.session_name : '';
  if (!session) return false;
  const provider = whatsapp ?? createWhatsAppProvider();
  const settings = await loadOwnerSettings(db, tenantId);
  const handled = await handleOwnerMessage(db, provider, tenantId, session, message.from, message.text, message.quoted, settings,
    meterAI(db, tenantId, createAIProvider()), message.id, message.chat);
  if (handled) await recordUsageEvent(db, { tenantId, eventType: 'message_observed', eventKey: message.id ?? `${message.chat}:${Date.now()}`, metadata: { reason: 'owner_control', billable: false } });
  return handled;
}
