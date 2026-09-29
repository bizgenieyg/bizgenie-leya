import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, pgliteDatabaseClient } from './test-support/pglite-harness.js';
import { createSource, sourceWithDrafts } from './knowledge-sources.service.js';
import { confirmSource, knowledgeProfile, updateFact } from './business-facts.service.js';
import { decideAuditItem, openAuditItems, runAudit, saveCandidates } from './knowledge-audit.service.js';
import { simulateCustomerMessage } from './simulator.service.js';
import { saveRuntimeSettings } from './runtime-settings.service.js';
import { handleSuggestionReply, proposeKnowledgeSuggestion } from './knowledge-suggestions.service.js';
import { formatMigration, migrateKnowledge } from './knowledge-migration.service.js';
import { invalidateOwnerSettings } from './owner-settings.service.js';

process.env.GEMINI_API_KEY = '';
process.env.SUPABASE_URL = 'https://database.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';
process.env.KNOWLEDGE_LIMIT_STATE_DIR = `/tmp/leya-knowledge-test-${process.pid}`;

const PRICE = 'Прайс салона.\nМаникюр с покрытием — 150 ₪.\nПедикюр — 180 ₪.\nАдрес: Ришон-ле-Цион, ул. Герцль 1, вс–чт 9–19.';
/** Task model stand-in: extraction by prompt, audit/objection answers from a queue. */
function taskModel(queue: Record<string, unknown>[] = []) {
  const calls: string[] = [];
  return { calls, ai: { async generateReply(input: { systemPrompt: string; userMessage: string }) {
    calls.push(input.systemPrompt.slice(0, 40));
    if (input.systemPrompt.startsWith('Ты разбираешь материалы')) {
      const { sourceText, currentFacts } = JSON.parse(input.userMessage) as { sourceText: string; currentFacts: Array<{ id: string; text: string }> };
      const facts = [], conflicts = [];
      if (sourceText.includes('Маникюр с покрытием — 150 ₪')) facts.push({ topic: 'services_prices', text: 'Маникюр с покрытием — 150 ₪.', quote: 'Маникюр с покрытием — 150 ₪' });
      if (sourceText.includes('Педикюр — 180 ₪')) facts.push({ topic: 'services_prices', text: 'Педикюр — 180 ₪.', quote: 'Педикюр — 180 ₪' });
      if (sourceText.includes('Ришон')) facts.push({ topic: 'location_hours', text: 'Ришон-ле-Цион, ул. Герцль 1, вс–чт 9–19.', quote: 'Ришон-ле-Цион, ул. Герцль 1, вс–чт 9–19' });
      const old = currentFacts.find(f => f.text.startsWith('Педикюр'));
      if (sourceText.includes('Педикюр — 200 ₪') && old) conflicts.push({ fact_id: old.id, new_text: 'Педикюр — 200 ₪.', quote: 'Педикюр — 200 ₪' });
      facts.push({ topic: 'why_us', text: 'Лучший салон города.', quote: 'этой фразы в тексте нет' });
      return { text: JSON.stringify({ facts, conflicts, gaps: ['booking'] }) };
    }
    return { text: JSON.stringify(queue.shift() ?? { items: [], gaps: [] }) };
  } } };
}

async function fixture() {
  const pg = await createTestDatabase();
  const db = pgliteDatabaseClient(pg);
  const tenantId = ((await db.from('tenants').insert({ name: 'Анна', business_name: 'Салон Анны', language: 'ru', tier: 'basic', status: 'active', business_sector: 'маникюр' }).select('id').single()).data as { id: string }).id;
  await pg.query("insert into notification_settings(tenant_id,owner_phone,owner_chat_id,mode,time_zone,auto_replies_paused) values($1,'972500000002','972500000002@c.us','mute_all','Asia/Jerusalem',false)", [tenantId]);
  await pg.query("insert into plans(code,display_name,messages_per_month,voice_minutes_per_month,warning_percent,unlimited) values('basic','Базовый',500,60,80,false) on conflict(code) do nothing");
  await pg.query("insert into tenant_usage_limits(tenant_id,plan,messages_per_month,voice_minutes_per_month,warning_percent,messages_overridden,voice_overridden,warning_overridden) values($1,'basic',500,60,80,false,false,false)", [tenantId]);
  await pg.query("insert into assistant_profiles(tenant_id,assistant_name,allowed_languages,tone) values($1,'Лея',array['ru'],'friendly_professional')", [tenantId]);
  return { pg, db, tenantId };
}

test('text → facts with valid quotes as drafts → "Верно" → the simulator answers from facts, not raw sources', async () => {
  const f = await fixture();
  try {
    const model = taskModel();
    const { id, done } = await createSource(f.db, f.tenantId, { kind: 'text', text: PRICE }, { taskAI: model.ai as never, embedder: null, audit: false });
    await done;
    const source = await sourceWithDrafts(f.db, f.tenantId, id);
    assert.equal(source.status, 'ready');
    assert.deepEqual(source.drafts.map(d => d.text), ['Маникюр с покрытием — 150 ₪.', 'Педикюр — 180 ₪.', 'Ришон-ле-Цион, ул. Герцль 1, вс–чт 9–19.'], 'the fact without a real quote is dropped');
    assert.equal((await knowledgeProfile(f.db, f.tenantId)).filled, 0, 'drafts do not count');
    assert.deepEqual(await confirmSource(f.db, f.tenantId, id), { activated: 3 });
    const profile = await knowledgeProfile(f.db, f.tenantId);
    assert.equal(profile.filled, 2); assert.equal(profile.required, 6);
    assert.deepEqual(profile.topics.filter(t => t.required && !t.facts.length).map(t => t.topic), ['booking', 'faq', 'payment_cancel', 'why_us']);

    await saveRuntimeSettings(f.db, f.tenantId, { knowledge_mode: 'facts' });
    await f.pg.query("insert into knowledge_items(tenant_id,type,question,answer,active) values($1,'faq','Старый вопрос','Старый ответ',true)", [f.tenantId]);
    await f.pg.query("insert into assistant_rules(tenant_id,text) values($1,'Не обещай скидки')", [f.tenantId]);
    const prompts: Array<{ system: string; user: string }> = [];
    const replyAI = { async generateReply(input: { systemPrompt: string; userMessage: string }) { prompts.push({ system: input.systemPrompt, user: input.userMessage });
      return { text: input.systemPrompt.includes('классификатор') ? '{"agent":"SALE","confidence":0.9}' : JSON.stringify({ reply: 'Маникюр с покрытием — 150 ₪.', unanswered: [], intent: 'sale' }) }; } };
    const r = await simulateCustomerMessage(f.db, f.tenantId, crypto.randomUUID(), 'сколько стоит маникюр?', replyAI as never, { evaluation: {}, embedder: null });
    assert.equal(r.reply, 'Маникюр с покрытием — 150 ₪.');
    const answer = prompts.at(-1)!, user = JSON.parse(answer.user) as Record<string, unknown>;
    assert.match(String(user.businessProfile), /^## услуги и цены\n- Маникюр с покрытием — 150 ₪\.\n- Педикюр — 180 ₪\.\n\n## адрес и часы работы/);
    assert.deepEqual(user.knowledge, [], 'no Q&A pairs in facts mode');
    assert.deepEqual(user.uploadedMaterials, [], 'no raw source text');
    assert.ok(!answer.user.includes('Прайс салона'), 'the raw source never reaches the answer model');
    assert.match(answer.system, /ПРАВИЛА ВЛАДЕЛЬЦА[^]*Не обещай скидки/);
    const keys = Object.keys(user);
    assert.ok(keys.indexOf('clientProfile') < keys.indexOf('businessProfile'), 'client profile before the business profile');
  } finally { await f.pg.close(); }
});

test('duplicates are skipped, a changed price becomes a "Было / Стало" card and never overwrites the fact', async () => {
  const f = await fixture();
  try {
    const model = taskModel();
    const first = await createSource(f.db, f.tenantId, { kind: 'text', text: PRICE }, { taskAI: model.ai as never, embedder: null, audit: false }); await first.done;
    await confirmSource(f.db, f.tenantId, first.id);
    const second = await createSource(f.db, f.tenantId, { kind: 'text', text: 'Маникюр с покрытием — 150 ₪.\nПедикюр — 200 ₪.' }, { taskAI: model.ai as never, embedder: null, audit: false }); await second.done;
    const drafts = await sourceWithDrafts(f.db, f.tenantId, second.id);
    assert.deepEqual(drafts.drafts, [], 'the same manicure fact is a duplicate');
    const cards = await openAuditItems(f.db, f.tenantId);
    assert.deepEqual(cards.map(c => [c.check_type, c.before_text, c.suggested_text]), [['conflict', 'Педикюр — 180 ₪.', 'Педикюр — 200 ₪.']]);
    const active = await f.pg.query<{ text: string }>("select text from business_facts where status='active' and text like 'Педикюр%'");
    assert.deepEqual(active.rows.map(r => r.text), ['Педикюр — 180 ₪.']);
    await decideAuditItem(f.db, f.tenantId, String(cards[0]!.id), 'accept', null, null);
    const after = await f.pg.query<{ text: string; status: string; supersedes_id: string | null }>("select text,status,supersedes_id from business_facts where text like 'Педикюр%' order by created_at");
    assert.deepEqual(after.rows.map(r => [r.text, r.status, !!r.supersedes_id]), [['Педикюр — 180 ₪.', 'archived', false], ['Педикюр — 200 ₪.', 'active', true]]);
  } finally { await f.pg.close(); }
});

test('audit: new numbers and claims dropped, priority and open-card limit, a skipped card is not offered again, a gap answer becomes a fact', async () => {
  const f = await fixture();
  try {
    const seed = taskModel();
    const s = await createSource(f.db, f.tenantId, { kind: 'text', text: PRICE }, { taskAI: seed.ai as never, embedder: null, audit: false }); await s.done;
    await confirmSource(f.db, f.tenantId, s.id);
    const facts = (await f.pg.query<{ id: string; text: string; topic: string }>("select id,text,topic from business_facts where status='active' order by created_at")).rows;
    const manicure = facts[0]!, address = facts[2]!;
    const model = taskModel([
      { items: [{ check: 'jargon', fact_id: manicure.id, suggested: 'Маникюр с покрытием, которое долго держится, — 150 ₪.', reason: 'непонятно', new_claims: [] },
        { check: 'no_benefit', fact_id: manicure.id, suggested: 'Маникюр, который держится 3 недели, — 150 ₪.', new_claims: [] },
        { check: 'no_benefit', fact_id: manicure.id, suggested: 'Маникюр с гарантией — 150 ₪.', new_claims: ['гарантия'] }] },
      { items: [] },
      { gaps: [{ objection: 'дорого', question: 'Клиенты часто пишут «дорого». Есть ли скидка на первый визит?' }] }]);
    const result = await runAudit(f.db, f.tenantId, { taskAI: model.ai as never, embedder: null });
    const cards = await openAuditItems(f.db, f.tenantId);
    assert.deepEqual(cards.map(c => c.check_type), ['objection', 'jargon', 'next_step'], 'priority 5 → 1 → 6; the invented "3 недели" and "гарантия" are gone');
    assert.equal(result.created, 3);
    assert.equal(cards.find(c => c.check_type === 'jargon')!.before_text, manicure.text, 'the fact is unchanged until the owner decides');
    // Skip → not offered again while the fact text is the same.
    const jargon = cards.find(c => c.check_type === 'jargon')!;
    await decideAuditItem(f.db, f.tenantId, String(jargon.id), 'skip', null, null);
    const again = await saveCandidates(f.db, f.tenantId, [{ kind: 'audit', check_type: 'jargon', topic: 'services_prices', fact_id: manicure.id, fact_fingerprint: manicure.text, before_text: manicure.text, suggested_text: 'x', question: null, reason: null }], 10);
    assert.equal(again, 0);
    // Gap answer → an active owner fact in the card's topic.
    const gap = cards.find(c => c.check_type === 'objection')!;
    const answered = await decideAuditItem(f.db, f.tenantId, String(gap.id), 'answer', 'Скидка 10 % на первый визит.', null);
    assert.equal(answered.fact?.topic, 'faq'); assert.equal(answered.fact?.status, 'active');
    // Limit: with room for one card only the highest-priority candidate is created.
    await f.pg.query("update knowledge_audit_items set status='dropped'");
    const limited = await saveCandidates(f.db, f.tenantId, [
      { kind: 'audit', check_type: 'scary', topic: 'location_hours', fact_id: address.id, fact_fingerprint: address.text, before_text: address.text, suggested_text: 'Адрес тот же.', question: null, reason: null },
      { kind: 'audit', check_type: 'no_price', topic: 'location_hours', fact_id: address.id, fact_fingerprint: address.text, before_text: address.text, suggested_text: 'Адрес и цены.', question: null, reason: null }], 1);
    assert.equal(limited, 1);
    assert.deepEqual((await openAuditItems(f.db, f.tenantId)).map(c => c.check_type), ['no_price']);
    // Owner edit of an active fact: new version, old archived.
    const edited = await updateFact(f.db, f.tenantId, address.id, 'Ришон-ле-Цион, Герцль 1. Открыто вс–чт с 9 до 19.', null);
    assert.equal(edited.status, 'active');
    assert.equal((await f.pg.query<{ status: string }>('select status from business_facts where id=$1', [address.id])).rows[0]!.status, 'archived');
  } finally { await f.pg.close(); }
});

test('an accepted owner answer becomes a business fact (in facts mode no Q&A pair)', async () => {
  const f = await fixture();
  try {
    await saveRuntimeSettings(f.db, f.tenantId, { knowledge_mode: 'facts' });
    invalidateOwnerSettings(f.db, f.tenantId);
    const conversation = (await f.pg.query<{ id: string }>("insert into clients(tenant_id,phone,whatsapp_jid) values($1,'972501111111','972501111111@c.us') returning id", [f.tenantId])).rows[0]!;
    const conv = (await f.pg.query<{ id: string }>("insert into conversations(tenant_id,client_id) values($1,$2) returning id", [f.tenantId, conversation.id])).rows[0]!;
    const esc = (await f.pg.query<{ id: string }>("insert into escalations(tenant_id,conversation_id,session,client_chat_id,client_name,question,status) values($1,$2,'s','972501111111@c.us','Дана','Есть парковка?','answered') returning id", [f.tenantId, conv.id])).rows[0]!;
    const ai = { async generateReply() { return { text: JSON.stringify({ useful: true, question: 'Есть ли парковка?', answer: 'Да, во дворе.', fact: 'Парковка есть во дворе.', topic: 'location_hours' }) }; } };
    assert.equal(await proposeKnowledgeSuggestion(f.db, { id: esc.id, tenant_id: f.tenantId, question: 'Есть парковка?', answer: 'Да, во дворе.' }, ai as never), true);
    const outbound = (await f.pg.query<{ id: string }>("insert into outbound_messages(tenant_id,session,chat_id,text,kind,priority,dedupe_key) values($1,'s','972500000002@c.us','Сводка','summary',2,'summary-1') returning id", [f.tenantId])).rows[0]!;
    await f.pg.query("update knowledge_suggestions set offered_in_outbound_id=$1, offer_position=1", [outbound.id]);
    assert.equal(await handleSuggestionReply(f.db, f.tenantId, [outbound.id], '1'), true);
    const fact = (await f.pg.query<{ topic: string; text: string; status: string; created_by: string }>('select topic,text,status,created_by from business_facts')).rows;
    assert.deepEqual(fact, [{ topic: 'location_hours', text: 'Парковка есть во дворе.', status: 'active', created_by: 'owner' }]);
    assert.equal(Number((await f.pg.query<{ n: string }>("select count(*)::text as n from knowledge_items")).rows[0]!.n), 0);
  } finally { await f.pg.close(); }
});

test('knowledge:migrate --dry-run prints facts by topic and gaps and writes nothing; a real run activates facts and switches the mode', async () => {
  const f = await fixture();
  try {
    await f.pg.query("insert into knowledge_documents(tenant_id,file_name,media_type,size_bytes,character_count,extracted_text,status,embedding_model,embedding_dimensions) values($1,'base.md','text/markdown',100,100,$2,'ready','m',768)", [f.tenantId, PRICE]);
    const model = taskModel();
    const dry = await migrateKnowledge(f.db, f.tenantId, model.ai as never, null, true);
    const report = formatMigration(dry);
    assert.match(report, /## services_prices\n- Маникюр с покрытием — 150 ₪\.\n  «Маникюр с покрытием — 150 ₪»/);
    assert.match(report, /Пробелы: booking, faq, payment_cancel, why_us/, 'required topics of the sector without facts, by code');
    assert.match(report, /Блоков: \d+; покрыто: \d+/);
    assert.equal(Number((await f.pg.query<{ n: string }>('select count(*)::text as n from business_facts')).rows[0]!.n), 0);
    assert.equal(Number((await f.pg.query<{ n: string }>('select count(*)::text as n from knowledge_sources')).rows[0]!.n), 0);
    const real = await migrateKnowledge(f.db, f.tenantId, model.ai as never, null, false);
    assert.equal(real.saved, 3);
    assert.equal((await f.pg.query<{ status: string }>("select distinct status from business_facts")).rows[0]!.status, 'active');
    assert.equal((await f.pg.query<{ document_id: string | null }>("select document_id from knowledge_sources")).rows[0]!.document_id !== null, true, 'the document is linked, not copied or deleted');
    assert.equal((await f.pg.query<{ mode: string }>("select behavior->>'knowledge_mode' as mode from notification_settings where tenant_id=$1", [f.tenantId])).rows[0]!.mode, 'facts');
  } finally { await f.pg.close(); }
});

test('RLS probe under a member JWT: facts of own tenant only; a viewer cannot write; rules are capped at 20', async () => {
  const f = await fixture();
  try {
    const other = ((await f.db.from('tenants').insert({ name: 'B', business_name: 'B', language: 'ru', tier: 'basic', status: 'active' }).select('id').single()).data as { id: string }).id;
    const owner = (await f.pg.query<{ id: string }>('insert into auth.users default values returning id')).rows[0]!.id;
    const viewer = (await f.pg.query<{ id: string }>('insert into auth.users default values returning id')).rows[0]!.id;
    await f.pg.query("insert into tenant_users(user_id,tenant_id,role) values($1,$2,'owner'),($3,$2,'viewer')", [owner, f.tenantId, viewer]);
    await f.pg.query("insert into business_facts(tenant_id,topic,text,status,created_by) values($1,'faq','Свой факт','active','owner'),($2,'faq','Чужой факт','active','owner')", [f.tenantId, other]);
    const as = async <T>(user: string, sql: string, params: unknown[] = []) => {
      await f.pg.query('begin'); await f.pg.query('set local role authenticated'); await f.pg.query(`select set_config('request.jwt.claim.sub', $1, true)`, [user]);
      try { return (await f.pg.query<T>(sql, params)).rows; } finally { await f.pg.query('rollback'); }
    };
    assert.deepEqual((await as<{ text: string }>(owner, 'select text from business_facts')).map(r => r.text), ['Свой факт']);
    await assert.rejects(as(viewer, "insert into business_facts(tenant_id,topic,text,status,created_by) values($1,'faq','x','active','owner')", [f.tenantId]));
    await as(owner, "insert into knowledge_audit_items(tenant_id,kind,check_type,topic,question) values($1,'gap','objection','faq','?')", [f.tenantId]);
    await assert.rejects(as(owner, "insert into business_facts(tenant_id,topic,text,status,created_by) values($1,'faq','x','active','owner')", [other]));
    for (let i = 0; i < 20; i++) await f.pg.query('insert into assistant_rules(tenant_id,text) values($1,$2)', [f.tenantId, `Правило ${i}`]);
    await assert.rejects(f.pg.query("insert into assistant_rules(tenant_id,text) values($1,'21-е')", [f.tenantId]), /assistant_limit_reached/);
  } finally { await f.pg.close(); }
});
