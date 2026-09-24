import assert from 'node:assert/strict';
import test from 'node:test';
import type { WhatsAppChatMessage, WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { createTestDatabase, pgliteDatabaseClient } from './test-support/pglite-harness.js';
import { stopOutboundQueue, settleAllOutboundQueues } from '../workers/outbound-queue.js';
process.env.GEMINI_API_KEY = '';
process.env.SUPABASE_URL = 'https://database.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';

const lid = '261885798707406@lid';
async function fixture(history: WhatsAppChatMessage[] | Error) {
  const pg = await createTestDatabase();
  const db = pgliteDatabaseClient(pg);
  const tenantId = ((await db.from('tenants').insert({ name: 'Business', business_name: 'Business', language: 'ru', tier: 'basic', status: 'active' }).select('id').single()).data as { id: string }).id;
  await pg.query("insert into notification_settings(tenant_id,mode,time_zone,auto_replies_paused) values($1,'mute_all','Asia/Jerusalem',false)", [tenantId]);
  await pg.query("insert into plans(code,display_name,messages_per_month,voice_minutes_per_month,warning_percent,unlimited) values('basic','Базовый',500,60,80,false) on conflict(code) do nothing");
  await pg.query("insert into tenant_usage_limits(tenant_id,plan,messages_per_month,voice_minutes_per_month,warning_percent,messages_overridden,voice_overridden,warning_overridden) values($1,'basic',500,60,80,false,false,false)", [tenantId]);
  await pg.query("insert into assistant_profiles(tenant_id,assistant_name,allowed_languages,tone) values($1,'Leya',array['ru'],'friendly_professional')", [tenantId]);
  await pg.query("insert into knowledge_items(tenant_id,type,question,answer,active) values($1,'faq','Часы работы?','С 9 до 18.',true)", [tenantId]);
  const sent: string[] = [], historyCalls: string[] = [], prompts: { system: string; history: unknown }[] = [];
  const provider: WhatsAppProvider = {
    async sendMessage(input) { sent.push(input.text); return { id: `reply-${sent.length}` }; },
    async getSessionStatus() { return { status: 'WORKING' }; },
    async getChatMessages(_session, chatId) { historyCalls.push(chatId); if (history instanceof Error) throw history; return history; },
  };
  const ai = { async generateReply(input: { systemPrompt: string; userMessage: string }) {
    if (input.systemPrompt.includes('классификатор намерений')) return { text: '{"agent":"SUPPORT","confidence":0.9}' };
    prompts.push({ system: input.systemPrompt, history: JSON.parse(input.userMessage).conversationHistory });
    return { text: 'Открыты с 9 до 18.' };
  } };
  const send = async (id: string, text: string) => {
    const { handleWebhookEvent } = await import('../workers/webhook.worker.js');
    await handleWebhookEvent(tenantId, { event: 'message', payload: { id, from: lid, fromMe: false, hasMedia: false, body: text, author: null, replyTo: null, _data: { Info: { PushName: 'Тест' } } } }, db, provider, ai as never); await settleAllOutboundQueues();
  };
  return { pg, tenantId, sent, historyCalls, prompts, send, async close() { await stopOutboundQueue(db); await pg.close(); } };
}

test('first contact loads WhatsApp history once, without re-introduction or persistence', async () => {
  const f = await fixture([
    { id: `false_${lid}_NOW`, timestamp: 300, fromMe: false, body: 'Когда вы открыты?', hasMedia: false },
    { id: `true_${lid}_OLD2`, timestamp: 200, fromMe: true, body: 'Добрый день, записала вас', hasMedia: false },
    { id: `false_${lid}_PIC`, timestamp: 150, fromMe: false, body: '', hasMedia: true },
    { id: `false_${lid}_OLD1`, timestamp: 100, fromMe: false, body: 'Хочу на маникюр', hasMedia: false },
  ]);
  try {
    await f.send(`false_${lid}_NOW`, 'Когда вы открыты?'); await settleAllOutboundQueues();
    assert.deepEqual(f.historyCalls, [lid]);
    assert.deepEqual(f.prompts[0]!.history, [
      { role: 'customer', text: 'Хочу на маникюр' }, { role: 'assistant', text: 'Добрый день, записала вас' }, { role: 'customer', text: 'Когда вы открыты?' }]);
    assert.match(f.prompts[0]!.system, /уже представлялся/);
    const stored = await f.pg.query<{ body: string }>('select body from messages where tenant_id=$1 order by created_at', [f.tenantId]);
    assert.ok(stored.rows.every(r => !['Хочу на маникюр', 'Добрый день, записала вас'].includes(r.body)));
    const c = await f.pg.query<{ at: string | null }>('select assistant_introduced_at at from conversations where tenant_id=$1', [f.tenantId]);
    assert.ok(c.rows[0]!.at);

    await f.send(`false_${lid}_NEXT`, 'А в пятницу?'); await settleAllOutboundQueues();
    assert.equal(f.historyCalls.length, 1, 'non-empty memory must not call WAHA');
  } finally { await f.close(); }
});

test('WAHA history failure answers without history and without retries', async () => {
  const f = await fixture(new Error('timeout'));
  try {
    await f.send(`false_${lid}_NOW`, 'Когда вы открыты?'); await settleAllOutboundQueues();
    assert.equal(f.historyCalls.length, 1);
    assert.deepEqual(f.prompts[0]!.history, [{ role: 'customer', text: 'Когда вы открыты?' }]);
    assert.deepEqual(f.sent.at(-1), 'Открыты с 9 до 18.');
  } finally { await f.close(); }
});

test('no WAHA history request when the monthly limit is exhausted or the client opted out', async () => {
  const f = await fixture([{ id: `false_${lid}_OLD`, timestamp: 1, fromMe: true, body: 'Старое', hasMedia: false }]);
  try {
    await f.pg.query("update tenant_usage_limits set messages_per_month=0,messages_overridden=true where tenant_id=$1", [f.tenantId]);
    await f.send(`false_${lid}_NOW`, 'Когда вы открыты?'); await settleAllOutboundQueues();
    assert.deepEqual(f.historyCalls, []);
    await f.pg.query("update tenant_usage_limits set messages_per_month=500 where tenant_id=$1", [f.tenantId]);
    await f.pg.query("update clients set auto_reply_allowed=false where tenant_id=$1", [f.tenantId]);
    await f.pg.query("delete from messages where tenant_id=$1", [f.tenantId]);
    await f.send(`false_${lid}_NEXT`, 'Когда вы открыты?'); await settleAllOutboundQueues();
    assert.deepEqual(f.historyCalls, []);
  } finally { await f.close(); }
});
