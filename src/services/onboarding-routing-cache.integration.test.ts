import assert from 'node:assert/strict';
import test from 'node:test';
import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { createTestDatabase, pgliteDatabaseClient } from './test-support/pglite-harness.js';
import { settleOutboundQueue, stopOutboundQueue } from '../workers/outbound-queue.js';
import { OnboardingService } from './onboarding.service.js';
import { getTenantRouting } from './tenant.service.js';
process.env.GEMINI_API_KEY = '';
process.env.SUPABASE_URL = 'https://database.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';

test('warm routing cache → complete() → the first client message is answered at once', async () => {
  const { handleWebhookEvent } = await import('../workers/webhook.worker.js');
  const pg = await createTestDatabase();
  const db = pgliteDatabaseClient(pg);
  try {
    await pg.query("insert into plans(code,display_name,messages_per_month,voice_minutes_per_month,warning_percent,unlimited) values('basic','Базовый',500,60,80,false) on conflict(code) do nothing");
    const onboarding = new OnboardingService(db);
    const { tenantId, token } = await onboarding.createTenant({ name: 'Business', phone: '972500000009' });
    await pg.query("insert into notification_settings(tenant_id,mode,time_zone,auto_replies_paused) values($1,'mute_all','Asia/Jerusalem',false)", [tenantId]);
    await pg.query("insert into knowledge_items(tenant_id,type,question,answer,active) values($1,'faq','Часы работы?','С 9 до 18.',true)", [tenantId]);
    assert.equal((await getTenantRouting(db, tenantId))?.tenant.status, 'draft'); // cache is warm with a non-serviceable status
    await onboarding.complete(token);
    assert.equal((await getTenantRouting(db, tenantId))?.tenant.status, 'trial');
    const sent: string[] = [];
    const provider: WhatsAppProvider = { async sendMessage(input) { sent.push(input.text); return { id: `r-${sent.length}` }; },
      async getSessionStatus() { return { status: 'WORKING' }; } };
    await handleWebhookEvent(tenantId, { event: 'message', payload: { from: '972500000001@c.us', fromMe: false, hasMedia: false,
      body: 'Часы работы?', author: null, replyTo: null, _data: { Info: { PushName: 'Тест' } } } }, db, provider, null);
    await settleOutboundQueue(db);
    assert.deepEqual(sent, ['С 9 до 18.']);
  } finally { await stopOutboundQueue(db); await pg.close(); }
});
