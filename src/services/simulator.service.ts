import { randomUUID } from 'node:crypto';
import { createAIProvider } from '../providers/ai/index.js';
import type { AIProvider } from '../providers/ai/ai-provider.interface.js';
import type { DatabaseClient } from '../db/supabase.js';
import type { ClientRow, ConversationRow } from './tenant.service.js';
import type { ConversationMemory } from './context.service.js';
import { loadOwnerSettings, ownerDestination } from './owner-settings.service.js';
import { behavior } from './runtime-settings.service.js';
import { meterAI } from './metered-providers.js';
import { recordUsageEvent } from './usage.service.js';
import { reserveSimulatorCall } from './simulator-rate-limit.js';
import { processCustomerMessage, type PipelineResult, type PipelineSink } from './message-pipeline.service.js';
import { escalationWaitingMessage } from './owner-workflow.service.js';
import { withoutRepeatedIntroduction } from '../utils/assistant-text.js';
import { HttpError } from '../utils/http-error.js';
import { allowedRecipient } from '../utils/incoming-policy.js';

export type SimulationResult = PipelineResult;
type SessionState = { introduced: boolean; routed_agent: string | null; route_selected_at: string | null;
  source_label: string | null; reception_message_count: number; client_time_zone: string | null };

async function sessionState(db: DatabaseClient, tenantId: string, sessionId: string): Promise<SessionState> {
  const find = () => db.from('simulator_sessions').select('*').eq('tenant_id', tenantId).eq('id', sessionId).maybeSingle();
  let row = await find();
  if (row.error) throw new HttpError(500, 'Could not load simulator session');
  if (!row.data) {
    const inserted = await db.from('simulator_sessions').insert({ tenant_id: tenantId, id: sessionId });
    if (inserted.error && inserted.error.code !== '23505') throw new HttpError(500, 'Could not create simulator session');
    row = await find();
  }
  if (row.error || !row.data) throw new HttpError(500, 'Could not load simulator session');
  return row.data as SessionState;
}

export async function simulateCustomerMessage(db: DatabaseClient, tenantId: string, sessionId: string, text: string,
  ai: AIProvider | null = createAIProvider(), limitOptions?: { now?: Date; root?: string }): Promise<SimulationResult> {
  const settings = await loadOwnerSettings(db, tenantId);
  const config = behavior(settings);
  const now = limitOptions?.now ?? new Date();
  const reservation = await reserveSimulatorCall(tenantId, config.simulator_hourly_limit, config.simulator_daily_limit, now, limitOptions?.root);
  if (!reservation.allowed) throw new HttpError(429, reservation.period === 'hour' ? 'Simulator hourly limit reached' : 'Simulator daily limit reached',
    { code: reservation.period === 'hour' ? 'simulator_hourly_limit' : 'simulator_daily_limit' });

  const state = await sessionState(db, tenantId, sessionId);
  const cutoff = new Date(now.getTime() - config.context_retention_hours * 3600000).toISOString();
  const history = await db.from('simulator_messages').select('from_me,body,created_at')
    .eq('tenant_id', tenantId).eq('session_id', sessionId).gte('created_at', cutoff)
    .order('sequence', { ascending: false }).limit(config.context_message_count);
  if (history.error) throw new HttpError(500, 'Could not load simulator history');
  const previous: ConversationMemory[] = (history.data ?? []).reverse().map(row => ({ fromMe: row.from_me === true,
    text: String(row.body), createdAt: String(row.created_at) }));
  const inserted = await db.from('simulator_messages').insert({ tenant_id: tenantId, session_id: sessionId,
    from_me: false, body: text, created_at: now.toISOString() });
  if (inserted.error) throw new HttpError(500, 'Could not save simulator message');
  const memory = { messages: [...previous, { fromMe: false, text, createdAt: now.toISOString() }].slice(-config.context_message_count),
    introduced: state.introduced };
  const conversation: ConversationRow = { id: sessionId, tenant_id: tenantId, client_id: sessionId, status: 'active',
    routed_agent: state.routed_agent, route_selected_at: state.route_selected_at, source_label: state.source_label,
    reception_message_count: state.reception_message_count, last_message_at: previous.at(-1)?.createdAt ?? null };
  const client: ClientRow = { id: sessionId, tenant_id: tenantId, phone: '', name: null, time_zone: state.client_time_zone };
  let sentReply: string | null = null;
  const saveReply = async (reply: string): Promise<void> => {
    const saved = await db.from('simulator_messages').insert({ tenant_id: tenantId, session_id: sessionId,
      from_me: true, body: reply, created_at: now.toISOString() });
    if (saved.error) throw new HttpError(500, 'Could not save simulator reply');
  };
  const sink: PipelineSink = {
    mode: 'simulation',
    isConversationPaused: async () => false,
    onClientOptOut: async () => {},
    admit: async () => {
      const summary = await db.rpc('tenant_usage_summary', { p_tenant_id: tenantId, p_default_messages: 0,
        p_default_voice_seconds: 0, p_now: now.toISOString() });
      if (summary.error || !summary.data) return { allowed: true, duplicate: false, unavailable: true };
      return { allowed: Number(summary.data.messages_used) < Number(summary.data.messages_limit), duplicate: false };
    },
    afterAdmission: async () => {},
    sendToClient: async reply => { sentReply = reply; return null; },
    persistAssistantMessage: async answer => { await saveReply(answer); },
    createEscalation: async language => {
      const destination = ownerDestination(settings);
      if (!destination || !allowedRecipient(destination)) return null;
      const waiting = escalationWaitingMessage(text, settings, client.time_zone, language, now);
      const reply = withoutRepeatedIntroduction(waiting.text, memory.introduced);
      sentReply = reply;
      return reply;
    },
    markIntroduced: async () => { memory.introduced = true; },
    recordUsage: async (eventType, options) => {
      if (eventType !== 'model_call') return;
      await recordUsageEvent(db, { tenantId, eventType, ...(options?.eventKey ? { eventKey: options.eventKey } : {}),
        metadata: { ...options?.metadata, simulation: true } });
    },
    recordAgentAction: async () => {},
    updateClientTimeZone: async zone => { client.time_zone = zone; },
    incrementReceptionCounter: async () => { conversation.reception_message_count = Number(conversation.reception_message_count ?? 0) + 1; },
  };
  const model = meterAI(db, tenantId, ai, { simulation: true, purpose: 'simulator_reply' });
  const response = await processCustomerMessage({ db, tenantId, text, client, conversation, memory, settings, ai, model,
    usageKey: randomUUID(), sink, now });
  const updated = await db.from('simulator_sessions').update({ introduced: memory.introduced,
    routed_agent: conversation.routed_agent, route_selected_at: now.toISOString(), source_label: conversation.source_label,
    reception_message_count: conversation.reception_message_count ?? 0, client_time_zone: client.time_zone, updated_at: now.toISOString() })
    .eq('tenant_id', tenantId).eq('id', sessionId);
  if (updated.error) throw new HttpError(500, 'Could not save simulator session');
  return { ...response, reply: sentReply ?? response.reply };
}
