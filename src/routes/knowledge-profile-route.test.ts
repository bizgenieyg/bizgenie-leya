import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';

process.env.SUPABASE_URL = 'https://database.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';
process.env.ADMIN_SECRET = 'admin-test-secret';
process.env.PUBLIC_BASE_URL = 'https://api.example.com';
process.env.WAHA_URL = 'https://waha.invalid';
process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const TENANT = '123e4567-e89b-42d3-a456-426614174000';

test('GET /api/admin/knowledge/profile returns the assistant name and the sector offering (task V)', async () => {
  const originalFetch = globalThis.fetch;
  const table = (url: string) => new URL(url).pathname.split('/').pop();
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith('https://database.invalid/')) return originalFetch(input, init);
    const name = table(url);
    if (name === 'tenants') return Response.json({ business_sector: 'прокат автомобилей' });
    if (name === 'assistant_profiles') return Response.json({ assistant_name: 'Гоша' });
    if (name === 'escalations') return new Response(null, { status: 200, headers: { 'Content-Range': '0-0/2' } });
    return Response.json([]);
  };
  const { app } = await import('../server.js');
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const call = (auth: string) => originalFetch(`http://127.0.0.1:${address.port}/api/admin/knowledge/profile?tenantId=${TENANT}`, { headers: { Authorization: auth } });
    assert.equal((await call('Bearer wrong')).status, 401);
    const response = await call('Bearer admin-test-secret');
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.assistant_name, 'Гоша');
    assert.equal(body.offering, 'rental');
    assert.equal(body.waiting_questions, 2);
    assert.equal((await originalFetch(`http://127.0.0.1:${address.port}/api/admin/knowledge/profile?tenantId=nope`, { headers: { Authorization: 'Bearer admin-test-secret' } })).status, 400);
  } finally {
    server.close(); server.closeAllConnections();
    globalThis.fetch = originalFetch;
  }
});
