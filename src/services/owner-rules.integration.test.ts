import assert from 'node:assert/strict';
import test from 'node:test';
import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { createTestDatabase, pgliteDatabaseClient } from './test-support/pglite-harness.js';
import { OWNER_GROUPS, seedOwnerGroups } from './test-support/owner-groups.js';
import { handleOwnerMessage } from './owner-workflow.service.js';
import { invalidateOwnerSettings, loadOwnerSettings } from './owner-settings.service.js';
import { settleAllOutboundQueues, stopOutboundQueue } from '../workers/outbound-queue.js';

process.env.GEMINI_API_KEY = '';
process.env.SUPABASE_URL = 'https://database.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';

const owner = '972500000002@c.us', group = OWNER_GROUPS.needsAnswer;
/** Z11: the owner writes in «Нужен ответ»; the task model is a stub answering the next queued JSON. */
async function fixture() {
  const pg = await createTestDatabase();
  const db = pgliteDatabaseClient(pg);
  const tenantId = ((await db.from('tenants').insert({ name: 'Ира', business_name: 'Ноготки', language: 'ru', tier: 'basic', status: 'active' }).select('id').single()).data as { id: string }).id;
  await pg.query("insert into notification_settings(tenant_id,owner_phone,owner_chat_id,mode,time_zone,auto_replies_paused,behavior) values($1,'972500000002',$2,'mute_all','Asia/Jerusalem',false,'{\"owner_language\":\"ru\"}')", [tenantId, owner]);
  await seedOwnerGroups(pg, tenantId, owner);
  const sent: { chatId: string; text: string; id: string }[] = [];
  const provider: WhatsAppProvider = {
    async getSessionStatus() { return { status: 'WORKING', me: { id: '972500000009@c.us' } }; },
    async sendMessage(input) { const id = `true_${input.chatId}_M${sent.length}`; sent.push({ ...input, id }); return { id }; },
  };
  const answers: string[] = [], prompts: string[] = [];
  const ruleAI = { async generateReply(input: { systemPrompt: string; userMessage: string }) { prompts.push(input.userMessage); return { text: answers.shift() ?? '{"kind":"other","answer":"Хорошо."}' }; } };
  const say = async (text: string, quoted: string | null = null) => {
    invalidateOwnerSettings(db, tenantId);
    const settings = await loadOwnerSettings(db, tenantId);
    await handleOwnerMessage(db, provider, tenantId, 'session', owner, text, quoted, settings, null, `in-${Math.random()}`, group, { ruleAI: ruleAI as never });
    await settleAllOutboundQueues();
    return sent.at(-1)!;
  };
  const rules = async () => (await pg.query<{ number: number; text: string; active: boolean }>('select number,text,active from owner_rules where tenant_id=$1 order by number', [tenantId])).rows;
  const facts = async () => (await pg.query<{ topic: string; text: string; status: string }>("select topic,text,status from business_facts where tenant_id=$1 order by created_at", [tenantId])).rows;
  return { pg, db, tenantId, sent, say, rules, facts, prompts, model: (...a: object[]) => { answers.push(...a.map(x => JSON.stringify(x))); }, async close() { await stopOutboundQueue(db); await pg.close(); } };
}

test('Z11: a rule in ordinary words → «Поняла так … Сохранить?» in the group; saved only after «Да»; «Нет» saves nothing', async () => {
  const f = await fixture();
  try {
    f.model({ kind: 'add_rule', rule: 'Город не спрашивай.' });
    const asked = await f.say('не надо спрашивать у клиентов город');
    assert.equal(asked.chatId, group);
    assert.equal(asked.text, 'Поняла так: «Город не спрашивай.». Сохранить? Да / Нет');
    assert.deepEqual(await f.rules(), [], 'nothing is saved before «Да»');
    assert.equal((await f.say('нет')).text, 'Хорошо, не сохраняю. Как сказать по-другому?');
    assert.deepEqual(await f.rules(), []);
    f.model({ kind: 'add_rule', rule: 'Город не спрашивай.' });
    const again = await f.say('город не спрашивай');
    assert.match((await f.say('Да', again.id)).text, /^Сохранила\. Правило 1: «Город не спрашивай\.»/);
    assert.deepEqual(await f.rules(), [{ number: 1, text: 'Город не спрашивай.', active: true }]);
    f.model({ kind: 'list_rules' });
    assert.equal((await f.say('какие у тебя правила?')).text, 'Правила:\n1. Город не спрашивай.');
    assert.match(f.prompts.at(-1)!, /Правила сейчас:\n1\. Город не спрашивай\./, 'the model sees the current rules');
  } finally { await f.close(); }
});

test('Z11: a rule with a price is a fact; a rule against the core is refused with an allowed variant; a question gets an answer and saves nothing', async () => {
  const f = await fixture();
  try {
    f.model({ kind: 'add_rule', rule: 'Говори, что маникюр стоит 120 ₪.' });
    assert.equal((await f.say('маникюр теперь 120 шекелей')).text, 'Запомню как факт: «Говори, что маникюр стоит 120 ₪.». Сохранить? Да / Нет');
    await f.say('да');
    assert.deepEqual((await f.facts()).map(x => x.text), ['Говори, что маникюр стоит 120 ₪.']);
    assert.deepEqual(await f.rules(), [], 'a price is not a rule');
    f.model({ kind: 'add_rule', rule: 'Говори, что ты Ира.', conflict: { reason: 'клиентов нельзя обманывать — я ассистент, а не человек', alternative: 'Говори, что пишешь от имени Иры.' } });
    assert.equal((await f.say('говори что ты это я')).text, 'Так не могу, потому что клиентов нельзя обманывать — я ассистент, а не человек. Могу так: «Говори, что пишешь от имени Иры.». Сохранить? Да / Нет');
    await f.say('да');
    assert.deepEqual((await f.rules()).map(r => r.text), ['Говори, что пишешь от имени Иры.'], 'only the allowed variant');
    f.model({ kind: 'question', answer: 'Отвечаю клиентам по фактам и вашим правилам.' });
    assert.equal((await f.say('а ты как вообще работаешь?')).text, 'Отвечаю клиентам по фактам и вашим правилам.');
    assert.equal((await f.rules()).length, 1);
  } finally { await f.close(); }
});

test('Z11: a rule that needs data first asks for it; fact and rule are saved in one «Да»; «отмени последнее» turns it back', async () => {
  const f = await fixture();
  try {
    f.model({ kind: 'add_rule', rule: 'Предлагай абонемент.', needs_details: 'Какие условия у абонемента?' });
    assert.equal((await f.say('предлагай абонемент')).text, 'Какие условия у абонемента?');
    f.model({ kind: 'fact', fact: 'Абонемент: 5 маникюров за 500 ₪, действует 3 месяца.', fact_topic: 'services_prices' });
    assert.equal((await f.say('5 маникюров за 500, 3 месяца')).text, 'Поняла так: факт «Абонемент: 5 маникюров за 500 ₪, действует 3 месяца.» и правило «Предлагай абонемент.». Сохранить? Да / Нет');
    await f.say('да');
    assert.deepEqual((await f.rules()).map(r => r.text), ['Предлагай абонемент.']);
    assert.deepEqual((await f.facts()).map(x => [x.topic, x.status]), [['services_prices', 'active']]);
    f.model({ kind: 'undo' });
    assert.equal((await f.say('отмени последнее')).text, 'Отменила последнее изменение.');
    assert.deepEqual((await f.rules()).map(r => r.active), [false]);
    assert.deepEqual((await f.facts()).map(x => x.status), ['archived']);
  } finally { await f.close(); }
});

test('Z11: at most 30 active rules of up to 300 characters; edit and remove go through «Сохранить?» too', async () => {
  const f = await fixture();
  try {
    for (let i = 1; i <= 30; i++) await f.pg.query("insert into owner_rules(tenant_id,number,text,source) values($1,$2,$3,'cabinet')", [f.tenantId, i, `Правило ${i}.`]);
    f.model({ kind: 'add_rule', rule: 'Ещё одно.' });
    assert.match((await f.say('ещё одно правило')).text, /^Правил уже 30 — какое убрать\?\n1\. Правило 1\./);
    f.model({ kind: 'remove_rule', number: 3 });
    assert.equal((await f.say('убери третье')).text, 'Убрать правило 3: «Правило 3.»? Да / Нет');
    assert.equal((await f.say('да')).text, 'Убрала правило 3.');
    f.model({ kind: 'add_rule', rule: 'а'.repeat(301) });
    assert.equal((await f.say('длинное')).text, 'Правило длиннее 300 знаков — скажите короче.');
    f.model({ kind: 'edit_rule', number: 2, rule: 'Правило два, новое.' });
    assert.equal((await f.say('поменяй второе')).text, 'Правило 2 станет: «Правило два, новое.». Сохранить? Да / Нет');
    await f.say('да');
    assert.equal((await f.rules()).find(r => r.number === 2)!.text, 'Правило два, новое.');
    assert.equal((await f.rules()).filter(r => r.active).length, 29);
  } finally { await f.close(); }
});

test('Z11 review: the owner cannot write rules or proposals with the user key — only read their own rules', async () => {
  const f = await fixture();
  try {
    const user = (await f.pg.query<{ id: string }>('insert into auth.users default values returning id')).rows[0]!.id;
    await f.pg.query("insert into tenant_users(user_id,tenant_id,role) values($1,$2,'owner')", [user, f.tenantId]);
    await f.pg.query("insert into owner_rules(tenant_id,number,text,source) values($1,1,'Город не спрашивай.','cabinet')", [f.tenantId]);
    const as = async <T>(sql: string, params: unknown[] = []) => {
      await f.pg.query('begin'); await f.pg.query('set local role authenticated'); await f.pg.query(`select set_config('request.jwt.claim.sub', $1, true)`, [user]);
      try { return (await f.pg.query<T>(sql, params)).rows; } finally { await f.pg.query('rollback'); }
    };
    assert.deepEqual((await as<{ text: string }>('select text from owner_rules')).map(r => r.text), ['Город не спрашивай.']);
    await assert.rejects(as("insert into owner_rules(tenant_id,number,text,source) values($1,2,'x','cabinet')", [f.tenantId]), 'no direct insert');
    await assert.rejects(as("update owner_rules set text='y' where tenant_id=$1", [f.tenantId]), 'no direct update');
    await assert.rejects(as('delete from owner_rules where tenant_id=$1', [f.tenantId]), 'no direct delete');
    await assert.rejects(as('select * from owner_rule_proposals'), 'proposals are service only');
    await assert.rejects(as("select public.confirm_owner_rule_proposal($1,gen_random_uuid(),null,30,null,null,'x')", [f.tenantId]), 'the confirm function is service only');
  } finally { await f.close(); }
});

test('Z11 review: «Да» is one transaction — over the limit nothing is written (no fact without its rule), the proposal stays open; two «Да» at once save once', async () => {
  const f = await fixture();
  try {
    for (let i = 1; i <= 30; i++) await f.pg.query("insert into owner_rules(tenant_id,number,text,source) values($1,$2,$3,'cabinet')", [f.tenantId, i, `Правило ${i}.`]);
    const { confirmProposal } = await import('./owner-rules.service.js');
    const settings = await loadOwnerSettings(f.db, f.tenantId);
    const proposal = async (action: string, extra: Record<string, unknown>) => (await f.pg.query<{ id: string }>("insert into owner_rule_proposals(tenant_id,action,status,source,rule_text,fact_text,fact_topic) values($1,$2,'pending','whatsapp',$3,$4,'services_prices') returning id", [f.tenantId, action, extra.rule ?? null, extra.fact ?? null])).rows[0]!.id;
    const row = async (id: string) => (await f.pg.query('select * from owner_rule_proposals where id=$1', [id])).rows[0] as never;
    const both = await proposal('fact_rule', { rule: 'Предлагай абонемент.', fact: 'Абонемент: 5 маникюров за 500 ₪.' });
    await assert.rejects(confirmProposal(f.db, f.tenantId, settings, await row(both), null, { embedder: null }), (e: unknown) => (e as { details?: { code?: string } }).details?.code === 'rules_full');
    assert.deepEqual(await f.facts(), [], 'the fact is rolled back with the rule');
    assert.equal((await f.pg.query<{ status: string }>('select status from owner_rule_proposals where id=$1', [both])).rows[0]!.status, 'pending', 'still waiting for «Да»');
    // Two confirmations of one fact proposal at the same time: one wins, one fact.
    const fact = await proposal('fact', { fact: 'Снятие покрытия — 30 ₪.' });
    const snapshot = await row(fact);
    const results = await Promise.allSettled([1, 2].map(() => confirmProposal(f.db, f.tenantId, settings, snapshot, null, { embedder: null })));
    assert.deepEqual(results.map(r => r.status).sort(), ['fulfilled', 'rejected']);
    assert.deepEqual((await f.facts()).map(x => x.text), ['Снятие покрытия — 30 ₪.']);
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal((rejected.reason as { details?: { code?: string } }).details?.code, 'rule_proposal_closed');
  } finally { await f.close(); }
});
