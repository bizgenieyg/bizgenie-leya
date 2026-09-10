import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {inferredLanguage,requestsNoAutomaticReplies} from './client-cards.service.js';
import {buildOwnerSummary,summaryDue,summaryFailureState} from './owner-summary.service.js';

test('client preference detection is limited to language and explicit automation opt-out',()=>{
 assert.equal(inferredLanguage('שלום'),'he');assert.equal(inferredLanguage('Привет'),'ru');assert.equal(inferredLanguage('Hello'),'en');
 assert.equal(requestsNoAutomaticReplies('Не отвечай мне автоматически, пожалуйста'),true);assert.equal(requestsNoAutomaticReplies('Когда вы отвечаете?'),false);
});
test('summaryDue translates UTC labels and preserves IANA behavior',()=>{
 const base:any={behavior:{summary_frequency:'weekly',summary_time:'09:00',summary_weekday:1}};
 assert.equal(summaryDue({...base,time_zone:'UTC+3'},new Date('2026-09-14T05:59:00Z')),null);
 assert.equal(summaryDue({...base,time_zone:'UTC+3'},new Date('2026-09-14T06:00:00Z'))?.periodKey,'weekly:2026-09-14');
 assert.equal(summaryDue({...base,time_zone:'UTC-5'},new Date('2026-09-14T14:00:00Z'))?.periodKey,'weekly:2026-09-14');
 assert.equal(summaryDue({...base,time_zone:'Asia/Jerusalem'},new Date('2026-09-14T06:00:00Z'))?.days,7);
 assert.equal(summaryDue({...base,time_zone:'Asia/Jerusalem',behavior:{...base.behavior,summary_frequency:'off'}},new Date()),null);
});
test('tenant time zones reach Intl only through the shared formatter',()=>{
 for(const file of ['src/services/owner-summary.service.ts','src/services/escalation.service.ts'])assert.doesNotMatch(readFileSync(file,'utf8'),/new Intl\.DateTimeFormat/);
 assert.match(readFileSync('src/utils/time-zone.ts','utf8'),/zonedDateTimeFormat/);
});
test('summary delivery retries twice, then releases no further attempt',()=>{const now=new Date('2026-09-10T10:00:00Z');assert.deepEqual(summaryFailureState(1,now),{retry:true,status:'pending',scheduled_at:'2026-09-10T10:05:00.000Z'});assert.equal(summaryFailureState(3,now).status,'error');});
test('owner summary never counts a manual owner message as a bot resolution',async()=>{
 const rows:any={messages:[{conversation_id:'bot',from_me:false,msg_type:'text'},{conversation_id:'bot',from_me:true,msg_type:'text'},{conversation_id:'owner',from_me:false,msg_type:'text'},{conversation_id:'owner',from_me:true,msg_type:'owner_text'}],clients:[],escalations:[],unrecognized_routes:[]};
 const riser:any={from(table:string){const q:any={select(){return q},eq(){return q},gte(){return q},lt(){return q},limit(){return q},then(resolve:any){return Promise.resolve(resolve({data:rows[table],error:null}))}};return q;}};
 const result=await buildOwnerSummary(riser,'tenant',new Date('2026-09-01'),new Date('2026-09-08'));assert.equal(result.inquiries,2);assert.equal(result.closed_by_bot,1);
});
test('041 soft-delete preserves attribution, aggregate count and hard-delete removes profile only',async()=>{
 const db=new PGlite();try{
  await db.exec(readFileSync('supabase/migrations/001_phase1_schema.sql','utf8').replace('create extension if not exists pgcrypto;',''));
  await db.exec(readFileSync('supabase/migrations/20260910120000_040_client_cards_and_owner_summaries.sql','utf8'));
  await db.exec("create role anon; create role authenticated; create role service_role; alter table conversations add column routed_agent text; create table escalations(id uuid primary key default gen_random_uuid(),tenant_id uuid,conversation_id uuid,status text);");
  await db.exec(readFileSync('supabase/migrations/20260910130000_041_client_soft_delete_and_job_contracts.sql','utf8'));
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
