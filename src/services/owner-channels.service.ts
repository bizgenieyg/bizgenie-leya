import type { DatabaseClient } from '../db/supabase.js';
import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { extractMessageId } from '../providers/whatsapp/waha.provider.js';
import { OWNER_TOPICS, type OwnerTopic } from '../config/owner-channels.js';
import { allowedRecipient, isGroupChatJid, ownerIdentityField, readSessionIdentity, type SessionIdentity } from '../utils/incoming-policy.js';
import { toChatId } from '../utils/whatsapp-id.js';
import { normalizeWebhookMessage } from '../utils/webhook-message.js';
import { loadOwnerSettings, ownerDestination, type OwnerSettings } from './owner-settings.service.js';
import { behavior } from './runtime-settings.service.js';
import { renderText } from './templates.service.js';
import { logSystemEvent } from './logging.service.js';

/**
 * Z10: the owner gets messages in WhatsApp groups by topic («{имя} · Нужен ответ», «{имя} · Отчёты»), not in one
 * private chat. A group is created at the first message of its topic and kept in owner_channels; a group that is
 * gone (or the assistant was removed) is created again, with one line about it.
 *
 * Two setups: the owner's personal number differs from the business one — the owner is the group's participant;
 * one number for both — the group has only the business account (WhatsApp may require a participant to create it:
 * then the operator's `group_bootstrap_number` is added and removed at once). Nothing ever goes to a chat with
 * oneself.
 */
/** A chat the assistant may write to as the owner's: an owner group (allowed by the owner's number above) or an allowed number. */
export function ownerChatAllowed(chat: string | null): chat is string { return !!chat && (isGroupChatJid(chat) || allowedRecipient(chat)); }
export type OwnerMode = { kind: 'separate'; ownerChat: string } | { kind: 'same' } | { kind: 'none' };

export function ownerMode(settings: OwnerSettings, me: SessionIdentity): OwnerMode {
  if (!settings.owner_phone) return { kind: 'none' };
  if (ownerIdentityField(toChatId(settings.owner_phone), me)) return { kind: 'same' };
  return { kind: 'separate', ownerChat: ownerDestination(settings) };
}

type Channel = { id: string; chat_id: string; topic: string; checked_at: string; owner_chat: string | null };
type Deps = { send: (session: string, chatId: string, text: string, dedupeKey: string) => Promise<void>; now?: Date };

/** The language of group names and service lines: the owner's language as set, English when there is none. */
export function channelLanguage(settings: OwnerSettings): string {
  const stored = settings.behavior && typeof settings.behavior === 'object' ? (settings.behavior as Record<string, unknown>).owner_language : undefined;
  return typeof stored === 'string' && ['ru', 'he', 'en'].includes(stored) ? stored : 'en';
}
async function assistantName(db: DatabaseClient, tenantId: string): Promise<string> {
  const row = await db.from('assistant_profiles').select('assistant_name').eq('tenant_id', tenantId).maybeSingle();
  if (row.error) throw new Error('Assistant profile lookup failed');
  return String(row.data?.assistant_name ?? '').trim() || 'Leya';
}
export async function channelName(db: DatabaseClient, tenantId: string, settings: OwnerSettings, topic: OwnerTopic, name?: string): Promise<string> {
  return renderText(settings, `owner.channel_${topic}`, channelLanguage(settings), { name: name ?? await assistantName(db, tenantId) });
}
async function systemValue(db: DatabaseClient, key: string): Promise<string> {
  const row = await db.from('system_config').select('value').eq('key', key).maybeSingle();
  if (row.error) throw new Error('System config lookup failed');
  return typeof row.data?.value === 'string' ? row.data.value.trim() : '';
}

// Z10 review: one creation at a time per tenant and topic — two first messages must not create two groups (an extra
// group cannot be deleted through the API). leya-api runs as a single process (cluster mode is forbidden), so an
// in-process lock covers every caller; the unique index stays as the last guard.
const creating = new Map<string, Promise<string | null>>();

/** The chat of `topic` for this tenant: the stored group (checked every owner_channel_check_minutes), or a new one. */
export async function ownerChannel(db: DatabaseClient, provider: WhatsAppProvider, tenantId: string, session: string,
  settings: OwnerSettings, topic: OwnerTopic, deps: Deps): Promise<string | null> {
  const key = `${tenantId}:${topic}`;
  const running = creating.get(key);
  if (running) { await running.catch(() => null); }
  const next = resolveChannel(db, provider, tenantId, session, settings, topic, deps);
  creating.set(key, next);
  try { return await next; } finally { if (creating.get(key) === next) creating.delete(key); }
}

async function resolveChannel(db: DatabaseClient, provider: WhatsAppProvider, tenantId: string, session: string,
  settings: OwnerSettings, topic: OwnerTopic, deps: Deps): Promise<string | null> {
  const now = deps.now ?? new Date();
  const me = readSessionIdentity((await provider.getSessionStatus(session)).me);
  const mode = ownerMode(settings, me);
  if (mode.kind === 'none' || !me.id) return null;
  // The recipient allowlist (test environments) applies to the owner's number: its groups go only where the owner may.
  if (!allowedRecipient(ownerDestination(settings))) return null;
  const found = await db.from('owner_channels').select('id,chat_id,topic,checked_at,owner_chat').eq('tenant_id', tenantId).eq('topic', topic).eq('status', 'active').maybeSingle();
  if (found.error) throw new Error('Owner channel lookup failed');
  const current = found.data as Channel | null;
  let recreated = false, previousOwner: string | null = null;
  const ownerChat = mode.kind === 'separate' ? mode.ownerChat : null;
  // Z10 review: the owner number changed (confirmed) — the old group belongs to the previous owner. It is retired, the
  // previous number is taken out of it (best effort), and a new group is created with the current owner.
  if (current && (current.owner_chat ?? null) !== ownerChat) {
    const retired = await db.from('owner_channels').update({ status: 'retired' }).eq('id', current.id);
    if (retired.error) throw new Error('Owner channel update failed');
    if (current.owner_chat) { try { await provider.removeGroupParticipants?.(session, current.chat_id, [current.owner_chat]); } catch { console.warn('owner_channel_previous_owner_remove_failed'); } }
    previousOwner = current.owner_chat ?? null;
  } else if (current) {
    const fresh = now.getTime() - Date.parse(current.checked_at) < behavior(settings).owner_channel_check_minutes * 60_000;
    if (fresh || !provider.hasGroup) return current.chat_id;
    let present = true;
    // A failed check (network, WAHA restart) keeps the group: only a confirmed «gone» creates a new one.
    try { present = await provider.hasGroup(session, current.chat_id); } catch { return current.chat_id; }
    if (present) {
      const checked = await db.from('owner_channels').update({ checked_at: now.toISOString() }).eq('id', current.id);
      if (checked.error) throw new Error('Owner channel update failed');
      return current.chat_id;
    }
    const lost = await db.from('owner_channels').update({ status: 'lost' }).eq('id', current.id);
    if (lost.error) throw new Error('Owner channel update failed');
    recreated = true;
  }
  if (!provider.createGroup) return null;
  const earlier = await db.from('owner_channels').select('id').eq('tenant_id', tenantId).neq('status', 'retired').limit(1);
  if (earlier.error) throw new Error('Owner channel lookup failed');
  const name = await assistantName(db, tenantId);
  const subject = await channelName(db, tenantId, settings, topic, name);
  let chatId: string, path: 'owner' | 'no_participants' | 'bootstrap';
  if (mode.kind === 'separate') { chatId = await provider.createGroup(session, { name: subject, participants: [mode.ownerChat] }); path = 'owner'; }
  else {
    try { chatId = await provider.createGroup(session, { name: subject, participants: [] }); path = 'no_participants'; }
    catch {
      const bootstrap = (await systemValue(db, 'group_bootstrap_number')).replace(/\D/g, '');
      if (!bootstrap) { await logSystemEvent(db, { tenantId, level: 'error', event: 'owner_channel_bootstrap_missing', details: { topic } }); return null; }
      const temporary = `${bootstrap}@c.us`;
      chatId = await provider.createGroup(session, { name: subject, participants: [temporary] });
      await provider.removeGroupParticipants?.(session, chatId, [temporary]);
      path = 'bootstrap';
    }
  }
  const saved = await db.from('owner_channels').insert({ tenant_id: tenantId, topic, chat_id: chatId, owner_chat: ownerChat, status: 'active', created_at: now.toISOString(), checked_at: now.toISOString() });
  if (saved.error) throw new Error('Owner channel save failed');
  await logSystemEvent(db, { tenantId, level: 'info', event: 'owner_channel_created', details: { topic, path, recreated, owner_changed: previousOwner !== null } });
  const language = channelLanguage(settings);
  // Cosmetics: a failed description or picture never blocks the message.
  try { await provider.setGroupDescription?.(session, chatId, renderText(settings, `owner.channel_${topic}_description`, language)); } catch { console.warn('owner_channel_description_failed'); }
  const picture = await systemValue(db, 'owner_group_picture_url').catch(() => '');
  if (picture) { try { await provider.setGroupPicture?.(session, chatId, picture); } catch { console.warn('owner_channel_picture_failed'); } }
  if (recreated) await deps.send(session, chatId, renderText(settings, 'owner.channel_recreated', language), `owner-channel:${topic}:recreated:${now.getTime()}`);
  // An owner who got everything in the private chat until now hears once, there, where messages go from now on.
  if (!recreated && !earlier.data?.length && mode.kind === 'separate') {
    const [needsAnswer, reports] = await Promise.all(OWNER_TOPICS.map(item => channelName(db, tenantId, settings, item, name)));
    await deps.send(session, mode.ownerChat, renderText(settings, 'owner.channels_moved', language, { needs_answer: needsAnswer!, reports: reports! }), `owner-channels:moved:${tenantId}`);
  }
  return chatId;
}

/** The topic of a stored owner group, or null for any other group. */
export async function ownerChannelTopic(db: DatabaseClient, tenantId: string, chatId: string): Promise<OwnerTopic | null> {
  if (!chatId.endsWith('@g.us')) return null;
  const row = await db.from('owner_channels').select('topic').eq('tenant_id', tenantId).eq('chat_id', chatId).eq('status', 'active').maybeSingle();
  if (row.error) throw new Error('Owner channel lookup failed');
  return (OWNER_TOPICS as readonly string[]).includes(String(row.data?.topic)) ? row.data!.topic as OwnerTopic : null;
}

/** Z10: a new owner language or assistant name renames the existing groups (PUT subject). */
export async function renameOwnerChannels(db: DatabaseClient, provider: WhatsAppProvider, tenantId: string, session: string): Promise<void> {
  if (!provider.setGroupSubject) return;
  const rows = await db.from('owner_channels').select('topic,chat_id').eq('tenant_id', tenantId).eq('status', 'active');
  if (rows.error) throw new Error('Owner channel lookup failed');
  if (!rows.data?.length) return;
  const settings = await loadOwnerSettings(db, tenantId), name = await assistantName(db, tenantId);
  for (const row of rows.data) {
    if (!(OWNER_TOPICS as readonly string[]).includes(String(row.topic))) continue;
    try { await provider.setGroupSubject(session, String(row.chat_id), await channelName(db, tenantId, settings, row.topic as OwnerTopic, name)); }
    catch { console.warn('owner_channel_rename_failed'); }
  }
}

/**
 * Z10: a message in an owner group, as the owner's message. Separate numbers: the sender is the owner's personal
 * number. One number: the owner writes from the business account itself — an outgoing message; the assistant's
 * own sends (API source, known WhatsApp ids, a queued send of the same text) are not the owner.
 * Returns what the owner workflow needs, or null when this is not an owner message in an owner group.
 */
export async function ownerGroupMessage(db: DatabaseClient, tenantId: string, body: Record<string, unknown>,
  isOwnSend: (id: string, chat: string, text: string) => Promise<boolean>): Promise<{ chat: string; from: string; text: string; quoted: string | null; id: string | null; topic: OwnerTopic } | null> {
  const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const payload = record(body.payload), info = record(record(payload._data).Info);
  const chat = [info.Chat, payload.from, payload.to].find(value => typeof value === 'string' && value.endsWith('@g.us')) as string | undefined;
  if (!chat) return null;
  const topic = await ownerChannelTopic(db, tenantId, chat);
  if (!topic) return null;
  const text = typeof payload.body === 'string' ? payload.body.trim() : '';
  if (!text || payload.hasMedia === true) return null;
  const id = extractMessageId(payload.id) || null;
  const fromMe = payload.fromMe === true || info.IsFromMe === true;
  let from: string;
  if (fromMe) {
    if (payload.source === 'api') return null;
    if (await isOwnSend(id ?? '', chat, text)) return null;
    const me = readSessionIdentity(body.me);
    if (!me.id) return null;
    from = me.id;
  } else {
    const sender = [payload.participant, info.Sender].find(value => typeof value === 'string' && /^\d+@(c\.us|s\.whatsapp\.net|lid)$/.test(value)) as string | undefined;
    if (!sender) return null;
    from = sender.replace(/@s\.whatsapp\.net$/, '@c.us');
  }
  const normalized = normalizeWebhookMessage(body);
  return { chat, from, text, quoted: normalized.kind === 'message' ? normalized.replyToId : null, id, topic };
}

/** The group of `topic`, service lines through the outbound queue (owner notices). */
export async function ownerChat(db: DatabaseClient, provider: WhatsAppProvider, tenantId: string, session: string,
  settings: OwnerSettings, topic: OwnerTopic): Promise<string | null> {
  const { enqueueMessage } = await import('../workers/outbound-queue.js');
  return ownerChannel(db, provider, tenantId, session, settings, topic, { send: async (s, chatId, text, dedupeKey) => {
    await enqueueMessage(db, tenantId, provider, { session: s, chatId, text }, { kind: 'owner_notice', dedupeKey });
  } });
}
