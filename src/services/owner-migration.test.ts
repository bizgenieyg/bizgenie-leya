import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const migration=readFileSync('supabase/migrations/20260908075451_024_owner_escalation_workflow.sql','utf8');

test('024 real PostgreSQL: idempotent migration, tenant RLS, private pairing credentials and atomic learning',async()=>{
  const db=new PGlite();
  try{
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
      create schema auth;create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to anon,authenticated,service_role;
      create table public.tenant_users(tenant_id uuid,user_id uuid,role text);
      grant select on tenant_users to authenticated;`);
    await db.exec(readFileSync('supabase/migrations/001_phase1_schema.sql','utf8').replace('create extension if not exists pgcrypto;',''));
    await db.exec(readFileSync('supabase/migrations/003_phase1_rls.sql','utf8'));
    await db.exec('grant all on all tables in schema public to service_role;');
    await db.exec(migration);await db.exec(migration);
    const t1='10000000-0000-4000-8000-000000000001',t2='10000000-0000-4000-8000-000000000002',user='20000000-0000-4000-8000-000000000001';
    await db.query(`insert into tenants(id,name,phone)values($1,'A','111111111'),($2,'B','222222222')`,[t1,t2]);
    await db.query("insert into tenant_users values($1,$2,'owner')",[t1,user]);
    const conv=await db.query<{id:string}>("insert into conversations(tenant_id) values($1) returning id",[t1]);
    const e=await db.query<{id:string}>("insert into escalations(tenant_id,conversation_id,client_chat_id,client_name,question,session,status,answer,client_message_id,learning_state) values($1,$2,'12345678@lid','Client','Вопрос','session','delivered','Ответ','sent','awaiting') returning id",[t1,conv.rows[0]!.id]);
    await db.query("insert into notification_settings(tenant_id,owner_pairing_hash)values($1,'secret')",[t1]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);
    await db.exec('set role authenticated');
    assert.equal((await db.query('select id from escalations')).rows.length,1);
    assert.equal((await db.query('select tenant_id from notification_settings')).rows.length,1);
    await assert.rejects(db.query('select owner_pairing_hash from notification_settings'),/permission denied/);
    await assert.rejects(db.query("update escalations set status='delivered'"),/permission denied/);
    await assert.rejects(db.query('select confirm_escalation_learning($1,$2)',[t1,e.rows[0]!.id]),/permission denied/);
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",['20000000-0000-4000-8000-000000000002']);
    await db.exec('set role authenticated');assert.equal((await db.query('select id from escalations')).rows.length,0);await db.exec('reset role');
    await db.exec('set role anon');await assert.rejects(db.query('select id from escalations'),/permission denied/);await db.exec('reset role');
    await db.exec('set role service_role');
    await assert.rejects(db.query('select confirm_escalation_learning($1,$2)',[t2,e.rows[0]!.id]),/not ready/);
    const first=await db.query('select confirm_escalation_learning($1,$2) as id',[t1,e.rows[0]!.id]);
    const second=await db.query('select confirm_escalation_learning($1,$2) as id',[t1,e.rows[0]!.id]);
    assert.deepEqual(first.rows,second.rows);
    const faq=await db.query('select tenant_id,type,question,answer,source from knowledge_items');
    assert.deepEqual(faq.rows,[{tenant_id:t1,type:'faq',question:'Вопрос',answer:'Ответ',source:'owner_confirmed'}]);
  }finally{await db.close();}
});
