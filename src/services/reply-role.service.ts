import type { AIProvider } from '../providers/ai/ai-provider.interface.js';
import type { ConversationMemory } from './context.service.js';
import type { DialogState } from './dialog-state.js';
import { ROLE_HISTORY_MESSAGES, SUPPORT_KEYWORDS, type ReplyRole } from '../config/roles.js';
import { ROLE_CLASSIFIER_PROMPT } from '../config/instructions.js';

export const matchesSupportKeywords = (text: string) => SUPPORT_KEYWORDS.some(re => re.test(text));

/**
 * Z12 (as chef-bot intentRouter.js): support keywords → SUPPORT; a role already chosen in this dialog stays; otherwise
 * a short classifier over the last messages; any failure → SALES. The role is kept in the dialog state.
 */
export async function chooseRole(text: string, memory: ConversationMemory[], state: DialogState, classifier: AIProvider | null): Promise<ReplyRole> {
  if (matchesSupportKeywords(text)) return (state.role = 'SUPPORT');
  if (state.role) return state.role;
  let role: ReplyRole = 'SALES';
  if (classifier) {
    try {
      const recent = memory.slice(0, -1).slice(-ROLE_HISTORY_MESSAGES).map(m => `${m.fromMe ? 'Ассистент' : 'Клиент'}: ${m.text.slice(0, 500)}`).join('\n');
      const result = await classifier.generateReply({ systemPrompt: ROLE_CLASSIFIER_PROMPT,
        userMessage: `Контекст последних сообщений:\n${recent || '(истории нет, это начало диалога)'}\n\nПоследнее сообщение клиента: «${text.slice(0, 1000)}»`,
        generation: { maxOutputTokens: 256 } });
      if (/SUPPORT/i.test(result.text)) role = 'SUPPORT';
    } catch { console.warn('reply_role_classification_failed'); }
  }
  return (state.role = role);
}
