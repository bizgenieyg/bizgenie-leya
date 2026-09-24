import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { encryptCredential } from '../utils/crypto.js';

process.env.SUPABASE_URL = 'https://database.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';
process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.PUBLIC_BASE_URL = 'https://leya.example.com';
process.env.WAHA_URL = 'https://waha.invalid';

test('webhook authenticates before writes, returns 5xx on persistence failure and 200 only after saving', async () => {
  const originalFetch = globalThis.fetch;
  let failInsert = true;
  let saved = 0;
  let unauthorizedWrites = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith('https://database.invalid/')) return originalFetch(input, init);
    if (url.includes('/inbound_events') && init?.method === 'POST') {
      if (failInsert) return Response.json({ message: 'database unavailable' }, { status: 503 });
      saved++;
      return Response.json({ id: '123e4567-e89b-42d3-a456-426614174099' });
    }
    if (url.includes('/inbound_events')) { unauthorizedWrites++; return Response.json([]); }
    if (url.includes('/tenants?')) return Response.json({ id: '123e4567-e89b-42d3-a456-426614174000', status: 'active' });
    if (url.includes('/whatsapp_instances?')) return Response.json({ webhook_secret_encrypted: encryptCredential('tenant-secret', process.env.CREDENTIAL_ENCRYPTION_KEY!) });
    if (url.includes('/notification_settings?')) return Response.json({ owner_phone: null, owner_chat_id: null, mode: 'mute_all', auto_replies_paused: false });
    return Response.json([]);
  };
  const { app } = await import('../server.js');
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const send = (token: string) => originalFetch(`http://127.0.0.1:${address.port}/webhook/123e4567-e89b-42d3-a456-426614174000`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Webhook-Token': token } : {}) },
      body: JSON.stringify({ id: 'event-1', event: 'message', payload: { id: 'inbound-1', from: '972500000001@c.us', fromMe: false, hasMedia: false, body: 'private contents' } }),
    });
    for (const token of ['', 'wrong-secret']) assert.equal((await send(token)).status, 401);
    assert.equal(saved, 0);
    assert.equal(unauthorizedWrites, 0);
    assert.equal((await send('tenant-secret')).status, 500);
    assert.equal(saved, 0);
    failInsert = false;
    const accepted = await send('tenant-secret');
    assert.equal(accepted.status, 200);
    assert.equal(saved, 1);
    assert.deepEqual(await accepted.json(), { received: true });
  } finally {
    server.close(); server.closeAllConnections();
    globalThis.fetch = originalFetch;
  }
});
