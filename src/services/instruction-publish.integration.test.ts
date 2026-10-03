import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, pgliteDatabaseClient } from './test-support/pglite-harness.js';
import { activateInstruction, instructionTarget, listInstructions, uploadInstruction } from './instructions.service.js';
import { readRuntimeSettings, saveRuntimeSettings } from './runtime-settings.service.js';
import { publishInstruction, rollbackInstruction, type OperatorApi, type PublishTarget } from './instruction-publish.js';

process.env.GEMINI_API_KEY = '';
process.env.SUPABASE_URL = 'https://database.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';

/** The operator endpoints' services on PGlite (the HTTP layer only forwards to these). */
function serviceApi(db: ReturnType<typeof pgliteDatabaseClient>): OperatorApi {
  const t = (target: PublishTarget) => instructionTarget({ tenantId: target.tenantId, demoKey: target.demoKey });
  return {
    list: async target => listInstructions(db, t(target)) as never,
    upload: (target, content) => uploadInstruction(db, t(target), content) as never,
    activate: async (target, version) => { await activateInstruction(db, t(target), version); },
    settings: tenantId => readRuntimeSettings(db, tenantId) as never,
    saveSettings: async (tenantId, patch) => { await saveRuntimeSettings(db, tenantId, patch); },
  };
}

test('Z3 instructions:publish — publish, the same text again creates no version, a new text archives the old, dry-run, rollback', async () => {
  const pg = await createTestDatabase(), db = pgliteDatabaseClient(pg);
  try {
    const tenantId = ((await db.from('tenants').insert({ name: 'Юрий', business_name: 'BizGenie', language: 'ru', tier: 'basic', status: 'active' }).select('id').single()).data as { id: string }).id;
    await pg.query("insert into notification_settings(tenant_id,owner_phone,mode,time_zone) values($1,'972500000002','mute_all','Asia/Jerusalem')", [tenantId]);
    await pg.query("insert into plans(code,display_name,messages_per_month,voice_minutes_per_month,warning_percent,unlimited) values('basic','Базовый',500,60,80,false) on conflict(code) do nothing");
    await pg.query("insert into tenant_usage_limits(tenant_id,plan,messages_per_month,voice_minutes_per_month,warning_percent) values($1,'basic',500,60,80)", [tenantId]);
    const api = serviceApi(db), target = { tenantId };
    const versions = async () => (await pg.query<{ version: number; status: string }>("select version,status from assistant_instructions where tenant_id=$1 order by version", [tenantId])).rows.map(r => `${r.version}:${r.status}`);

    const plan = await publishInstruction(api, { target, content: 'Инструкция v1', engine: 'instruction', replyModel: 'gemini-3.8-flash', dryRun: true });
    assert.deepEqual(plan, [{ action: 'upload' }, { action: 'activate', version: 'new' }, { action: 'settings', patch: { reply_engine: 'instruction', reply_model: 'gemini-3.8-flash' } }]);
    assert.deepEqual(await versions(), [], 'dry-run changes nothing');

    await publishInstruction(api, { target, content: 'Инструкция v1', engine: 'instruction', replyModel: 'gemini-3.8-flash' });
    assert.deepEqual(await versions(), ['1:active']);
    const settings = await readRuntimeSettings(db, tenantId);
    assert.equal(settings.reply_engine, 'instruction'); assert.equal(settings.reply_model, 'gemini-3.8-flash');

    assert.deepEqual(await publishInstruction(api, { target, content: 'Инструкция v1', engine: 'instruction', replyModel: 'gemini-3.8-flash' }), [{ action: 'unchanged', version: 1 }]);
    assert.deepEqual(await versions(), ['1:active'], 'the same text twice: no new version');

    await publishInstruction(api, { target, content: 'Инструкция v2' });
    assert.deepEqual(await versions(), ['1:archived', '2:active']);
    assert.deepEqual(await publishInstruction(api, { target, content: 'Инструкция v1' }), [{ action: 'activate', version: 1 }], 'an older text is re-activated, not re-uploaded');
    assert.deepEqual(await versions(), ['1:active', '2:archived']);

    assert.deepEqual(await rollbackInstruction(api, tenantId, true), [{ action: 'settings', patch: { reply_engine: 'legacy' } }]);
    assert.equal((await readRuntimeSettings(db, tenantId)).reply_engine, 'instruction', 'rollback dry-run changes nothing');
    await rollbackInstruction(api, tenantId);
    assert.equal((await readRuntimeSettings(db, tenantId)).reply_engine, 'legacy');
    assert.deepEqual(await rollbackInstruction(api, tenantId), [], 'a second rollback has nothing to do');

    await publishInstruction(api, { target: { demoKey: 'home_cook' }, content: 'Демо повара' });
    assert.deepEqual(await publishInstruction(api, { target: { demoKey: 'home_cook' }, content: 'Демо повара' }), [{ action: 'unchanged', version: 1 }]);
    await assert.rejects(publishInstruction(api, { target: { demoKey: 'home_cook' }, content: 'x', engine: 'instruction' }), /apply to a tenant/);
  } finally { await pg.close(); }
});
