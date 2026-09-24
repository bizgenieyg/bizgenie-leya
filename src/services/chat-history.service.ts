import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import type { ConversationMemory } from './context.service.js';
import { replyId } from '../utils/assistant-text.js';

export interface ChatHistoryOptions { limit: number; maxCharacters: number; timeoutSeconds: number }

/**
 * One-shot WhatsApp history for a first contact. Text only, chronological, newest kept within the
 * character budget, excluding the current inbound batch. Never persisted; any failure yields [].
 */
export async function fetchChatHistory(provider: WhatsAppProvider, session: string, chatId: string,
  excludeIds: string[], options: ChatHistoryOptions): Promise<ConversationMemory[]> {
  if (!provider.getChatMessages || options.limit <= 0 || options.maxCharacters <= 0) return [];
  let rows;
  try { rows = await provider.getChatMessages(session, chatId, { limit: options.limit, timeoutMs: options.timeoutSeconds * 1000 }); }
  catch { console.warn('chat_history_unavailable'); return []; }
  const excluded = new Set(excludeIds.map(replyId));
  // Text only: media is excluded even when it carries a caption.
  const texts = rows.filter(row => !row.hasMedia && row.body.trim() && !excluded.has(replyId(row.id)))
    .sort((a, b) => a.timestamp - b.timestamp);
  const kept: ConversationMemory[] = [];
  let used = 0;
  for (const row of texts.reverse()) {
    const text = row.body.trim();
    if (used + text.length > options.maxCharacters) break;
    used += text.length;
    kept.unshift({ fromMe: row.fromMe, text, createdAt: new Date(row.timestamp * 1000).toISOString() });
  }
  return kept;
}
