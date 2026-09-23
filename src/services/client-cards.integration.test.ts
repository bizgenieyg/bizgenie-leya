import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {inferredLanguage,requestsNoAutomaticReplies} from './client-cards.service.js';
import {buildOwnerSummary,nextSummaryAt,summaryDue,summaryFailureState} from './owner-summary.service.js';
import {isGroupChatJid} from '../utils/incoming-policy.js';

test('client preference detection is limited to language and explicit automation opt-out',()=>{
 assert.equal(inferredLanguage('שלום'),'he');assert.equal(inferredLanguage('Привет'),'ru');assert.equal(inferredLanguage('Hello'),'en');
 assert.equal(requestsNoAutomaticReplies('Не отвечай мне автоматически, пожалуйста'),true);assert.equal(requestsNoAutomaticReplies('Когда вы отвечаете?'),false);
});
test('group chat JIDs share one classifier with persistence and ingress',()=>{
 assert.equal(isGroupChatJid('972501234567@g.us'),true);
 assert.equal(isGroupChatJid('120363123456789@c.us'),true);
 assert.equal(isGroupChatJid('972501234567@c.us'),false);
 assert.equal(isGroupChatJid('123456@lid'),false);
});
test('summaryDue translates UTC labels and preserves IANA behavior',()=>{
 const base:any={behavior:{summary_frequency:'weekly',summary_time:'09:00',summary_weekday:1}};
 assert.equal(summaryDue({...base,time_zone:'UTC+3'},new Date('2026-09-14T05:59:00Z')),null);
 assert.equal(summaryDue({...base,time_zone:'UTC+3'},new Date('2026-09-14T06:00:00Z'))?.periodKey,'weekly:2026-09-14');
 assert.equal(summaryDue({...base,time_zone:'UTC-5'},new Date('2026-09-14T14:00:00Z'))?.periodKey,'weekly:2026-09-14');
 assert.equal(summaryDue({...base,time_zone:'Asia/Jerusalem'},new Date('2026-09-14T06:00:00Z'))?.days,7);
 assert.equal(summaryDue({...base,time_zone:'Asia/Jerusalem',behavior:{...base.behavior,summary_frequency:'off'}},new Date()),null);
});
test('next summary follows the owner timezone and advances after a delivered period',()=>{
 const settings:any={time_zone:'Asia/Jerusalem',behavior:{summary_frequency:'daily',summary_time:'09:00'}};
 assert.equal(nextSummaryAt(settings,new Date('2026-09-14T05:59:00Z'))?.toISOString(),'2026-09-14T06:00:00.000Z');
 assert.equal(nextSummaryAt(settings,new Date('2026-09-14T06:01:00Z'))?.toISOString(),'2026-09-15T06:00:00.000Z');
});
test('tenant time zones reach Intl only through the shared formatter',()=>{
 for(const file of ['src/services/owner-summary.service.ts','src/services/escalation.service.ts'])assert.doesNotMatch(readFileSync(file,'utf8'),/new Intl\.DateTimeFormat/);
 assert.match(readFileSync('src/utils/time-zone.ts','utf8'),/zonedDateTimeFormat/);
});
test('summary delivery retries twice, then releases no further attempt',()=>{const now=new Date('2026-09-10T10:00:00Z');assert.deepEqual(summaryFailureState(1,now),{retry:true,status:'pending',scheduled_at:'2026-09-10T10:05:00.000Z'});assert.equal(summaryFailureState(3,now).status,'error');});
test('owner summary never counts a manual owner message as a bot resolution',async()=>{
 const rows:any={messages:[{conversation_id:'bot',from_me:false,msg_type:'text'},{conversation_id:'bot',from_me:true,msg_type:'text'},{conversation_id:'owner',from_me:false,msg_type:'text'},{conversation_id:'owner',from_me:true,msg_type:'owner_text'}],clients:[{id:'client',first_seen_at:'2026-09-02T00:00:00Z'}],conversations:[{id:'bot'},{id:'owner'}],escalations:[],agent_actions:[]};
 const riser:any={from(table:string){const q:any={select(){return q},eq(){return q},in(){return q},gte(){return q},lt(){return q},not(){return q},limit(){return q},then(resolve:any){return Promise.resolve(resolve({data:rows[table],error:null}))}};return q;}};
 const result=await buildOwnerSummary(riser,'tenant',new Date('2026-09-01'),new Date('2026-09-08'));assert.equal(result.inquiries,2);assert.equal(result.closed_by_bot,1);
});
test('owner summary counts only explicit knowledge gaps, not unresolved routes',async()=>{
 const rows:any={messages:[],clients:[{id:'client',first_seen_at:'2026-09-02T00:00:00Z'}],conversations:[{id:'conversation'}],escalations:[],agent_actions:[{input:'Сколько стоит доставка?'},{input:'Сколько стоит доставка?'}],unrecognized_routes:[{message_text:'👍'}]};
 const riser:any={from(table:string){const q:any={select(){return q},eq(){return q},in(){return q},gte(){return q},lt(){return q},not(){return q},limit(){return q},then(resolve:any){return Promise.resolve(resolve({data:rows[table],error:null}))}};return q;}};
 const result=await buildOwnerSummary(riser,'tenant',new Date('2026-09-01'),new Date('2026-09-08'));assert.deepEqual(result.missing_knowledge,[{question:'Сколько стоит доставка?',count:2}]);
});
test('041 soft-delete preserves attribution, aggregate count and hard-delete removes profile only',async()=>{
 const db=new PGlite();try{
  await db.exec(readFileSync('supabase/migrations/001_phase1_schema.sql','utf8').replace('create extension if not exists pgcrypto;',''));
  await db.exec(readFileSync('supabase/migrations/20260910120000_040_client_cards_and_owner_summaries.sql','utf8'));
  await db.exec("create role anon; create role authenticated; create role service_role; alter table conversations add column routed_agent text; create table escalations(id uuid primary key default gen_random_uuid(),tenant_id uuid,conversation_id uuid,status text);");
  await db.exec(readFileSync('supabase/migrations/20260910130000_041_client_soft_delete_and_job_contracts.sql','utf8'));
  await db.exec(readFileSync('supabase/migrations/20260917090000_046_client_chat_type.sql','utf8'));
  const t='10000000-0000-4000-8000-000000000001',c='20000000-0000-4000-8000-000000000001';
  await db.query("insert into tenants(id,name,phone)values($1,'T','1')",[t]);await db.query("insert into clients(id,tenant_id,phone,whatsapp_jid)values($1,$2,'123@lid','123@lid')",[c,t]);await db.query("insert into client_profiles(tenant_id,client_id)values($1,$2)",[t,c]);
  const conv=await db.query<{id:string}>('insert into conversations(tenant_id,client_id)values($1,$2)returning id',[t,c]);await db.query("insert into messages(tenant_id,conversation_id,from_me,body)values($1,$2,false,'private')",[t,conv.rows[0]!.id]);
  assert.equal((await db.query<{inquiry_count:number}>('select inquiry_count::int from client_card_stats($1,$2)',[t,c])).rows[0]!.inquiry_count,1);
  assert.equal((await db.query('select id from client_recent_messages($1,$2,20)',[t,c])).rows.length,1);
  await db.query('update clients set deleted_at=now() where id=$1',[c]);assert.equal((await db.query<{client_id:string}>('select client_id from conversations')).rows[0]!.client_id,c);
  await db.query('delete from clients where id=$1',[c]);assert.equal((await db.query('select id from messages')).rows.length,1);assert.equal((await db.query<{client_id:string|null}>('select client_id from conversations')).rows[0]!.client_id,null);assert.equal((await db.query('select id from client_profiles')).rows.length,0);
  await assert.rejects(db.query("insert into scheduled_jobs(tenant_id,job_type,scheduled_at,status)values($1,'invented',now(),'pending')",[t]));await assert.rejects(db.query("insert into scheduled_jobs(tenant_id,job_type,scheduled_at,status)values($1,'owner_summary',now(),'invented')",[t]));
 }finally{await db.close();}
});
test('046 backfills group chats and removes them from card aggregates',async()=>{
 const db=new PGlite();try{
  await db.exec(readFileSync('supabase/migrations/001_phase1_schema.sql','utf8').replace('create extension if not exists pgcrypto;',''));
  await db.exec(readFileSync('supabase/migrations/20260910120000_040_client_cards_and_owner_summaries.sql','utf8'));
  await db.exec("create role anon; create role authenticated; create role service_role; alter table conversations add column routed_agent text; create table escalations(id uuid primary key default gen_random_uuid(),tenant_id uuid,conversation_id uuid,status text);");
  await db.exec(readFileSync('supabase/migrations/20260910130000_041_client_soft_delete_and_job_contracts.sql','utf8'));
  const tenant='10000000-0000-4000-8000-000000000002';
  await db.query("insert into tenants(id,name,phone) values($1,'T','1')",[tenant]);
  await db.query("insert into clients(tenant_id,phone,whatsapp_jid) values($1,'120363999@c.us','120363999@c.us'),($1,'972501234567@c.us','972501234567@c.us')",[tenant]);
  await db.exec(readFileSync('supabase/migrations/20260917090000_046_client_chat_type.sql','utf8'));
  const types=await db.query<{whatsapp_jid:string;chat_type:string}>('select whatsapp_jid,chat_type from clients order by whatsapp_jid');
  assert.deepEqual(types.rows.map(row=>row.chat_type),['group','individual']);
  const visible=await db.query('select * from client_card_stats($1,null)',[tenant]);
  assert.equal(visible.rows.length,1);
 }finally{await db.close();}
});
test('clients with the same display name but different WhatsApp JIDs are never merged',async()=>{
 // Regression pin for the reverted merge-by-name behaviour (was migration 047 + a
 // findOrCreateClient fallback in commit e5025bc; 047 was never applied to the live
 // database and was removed outright rather than reverted forward). Two clients with
 // the same visible name but different JIDs (e.g. a personal account and an unrelated
 // group/session sharing a name) must stay separate rows — findOrCreateClient
 // (tenant.service.ts) only ever matches on an exact whatsapp_jid.
 const db=new PGlite();try{
  await db.exec(readFileSync('supabase/migrations/001_phase1_schema.sql','utf8').replace('create extension if not exists pgcrypto;',''));
  await db.exec(readFileSync('supabase/migrations/20260910120000_040_client_cards_and_owner_summaries.sql','utf8'));
  await db.exec("create role anon; create role authenticated; create role service_role; alter table conversations add column routed_agent text; create table escalations(id uuid primary key default gen_random_uuid(),tenant_id uuid,conversation_id uuid,status text);");
  await db.exec(readFileSync('supabase/migrations/20260910130000_041_client_soft_delete_and_job_contracts.sql','utf8'));
  await db.exec(readFileSync('supabase/migrations/20260917090000_046_client_chat_type.sql','utf8'));
  const tenant='10000000-0000-4000-8000-000000000003',first='20000000-0000-4000-8000-000000000001',second='20000000-0000-4000-8000-000000000002';
  await db.query("insert into tenants(id,name,phone) values($1,'T','1')",[tenant]);
  await db.query("insert into clients(id,tenant_id,phone,whatsapp_jid,name,first_seen_at) values($1,$3,'52377797296184','52377797296184@c.us','BNI Synergy','2026-09-06'),($2,$3,'52377797296184@lid','52377797296184@lid','BNI Synergy','2026-09-07')",[first,second,tenant]);
  await db.query('insert into conversations(tenant_id,client_id) values($1,$2)',[tenant,second]);
  assert.equal((await db.query<{count:number}>('select count(*)::int count from clients where tenant_id=$1',[tenant])).rows[0]!.count,2,'no automatic merge runs on insert');
  assert.equal((await db.query<{client_id:string}>('select client_id from conversations where tenant_id=$1',[tenant])).rows[0]!.client_id,second,'conversation stays on the client it was created for');
 }finally{await db.close();}
});
test('047 resets one tenant\'s customer data without touching settings or the knowledge base',async()=>{
 const db=new PGlite();try{
  await db.exec(readFileSync('supabase/migrations/001_phase1_schema.sql','utf8').replace('create extension if not exists pgcrypto;',''));
  await db.exec(readFileSync('supabase/migrations/20260910120000_040_client_cards_and_owner_summaries.sql','utf8'));
  await db.exec("create role anon; create role authenticated; create role service_role; alter table conversations add column routed_agent text; create table escalations(id uuid primary key default gen_random_uuid(),tenant_id uuid,conversation_id uuid,status text);");
  await db.exec(readFileSync('supabase/migrations/20260910130000_041_client_soft_delete_and_job_contracts.sql','utf8'));
  await db.exec(readFileSync('supabase/migrations/20260918101000_047_reset_tenant_customer_data.sql','utf8'));
  const tenant='10000000-0000-4000-8000-000000000004',client='20000000-0000-4000-8000-000000000003';
  await db.query("insert into tenants(id,name,phone) values($1,'T','1')",[tenant]);
  await db.query("insert into notification_settings(tenant_id,mode) values($1,'mute_all')",[tenant]);
  await db.query("insert into knowledge_items(tenant_id,type,answer) values($1,'faq','keep me')",[tenant]);
  await db.query("insert into clients(id,tenant_id,phone,whatsapp_jid,name) values($1,$2,'111','111@c.us','Client')",[client,tenant]);
  await db.query('insert into client_profiles(tenant_id,client_id,profile_md) values($1,$2,$3)',[tenant,client,'notes']);
  const conversation=(await db.query<{id:string}>('insert into conversations(tenant_id,client_id) values($1,$2) returning id',[tenant,client])).rows[0]!.id;
  await db.query("insert into messages(conversation_id,tenant_id,from_me,body) values($1,$2,false,'hi')",[conversation,tenant]);
  await db.query("insert into escalations(tenant_id,conversation_id,status) values($1,$2,'queued')",[tenant,conversation]);
  await db.query("insert into agent_actions(tenant_id,conversation_id,action_type) values($1,$2,'faq_answer_exact')",[tenant,conversation]);
  await db.query("insert into scheduled_jobs(tenant_id,job_type,payload,scheduled_at,status) values($1,'owner_summary','{}','2026-09-01','pending'),($1,'weekly_report','{}','2026-09-01','pending')",[tenant]);
  await db.query('select reset_tenant_customer_data($1)',[tenant]);
  for(const table of ['clients','conversations','messages','escalations','agent_actions','client_profiles'])
    assert.equal((await db.query<{count:number}>(`select count(*)::int count from ${table} where tenant_id=$1`,[tenant])).rows[0]!.count,0,table);
  assert.equal((await db.query<{count:number}>("select count(*)::int count from scheduled_jobs where tenant_id=$1 and job_type='owner_summary'",[tenant])).rows[0]!.count,0,'owner_summary jobs are cleared');
  assert.equal((await db.query<{count:number}>("select count(*)::int count from scheduled_jobs where tenant_id=$1 and job_type='weekly_report'",[tenant])).rows[0]!.count,1,'non-client scheduled jobs are untouched');
  assert.equal((await db.query<{count:number}>('select count(*)::int count from notification_settings where tenant_id=$1',[tenant])).rows[0]!.count,1,'settings survive the reset');
  assert.equal((await db.query<{count:number}>('select count(*)::int count from knowledge_items where tenant_id=$1',[tenant])).rows[0]!.count,1,'knowledge base survives the reset');
 }finally{await db.close();}
});
