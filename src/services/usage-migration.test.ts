import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const path='supabase/migrations/20260908164604_025_tenant_usage_limits.sql';
test('025 PostgreSQL quota admission, receipts, owner-local month, alerts, summary and RLS',async()=>{
  const db=new PGlite();
  try{
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
      create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to anon,authenticated,service_role;
      create table tenant_users(tenant_id uuid,user_id uuid,role text);grant select on tenant_users to authenticated;`);
    await db.exec(readFileSync('supabase/migrations/001_phase1_schema.sql','utf8').replace('create extension if not exists pgcrypto;',''));
    await db.exec(readFileSync('supabase/migrations/003_phase1_rls.sql','utf8'));
    await db.exec(readFileSync('supabase/migrations/20260908114713_024_owner_escalation_workflow.sql','utf8'));
    await db.exec('grant all on all tables in schema public to service_role;grant insert,update,delete on usage_events to authenticated;');
    await db.exec(readFileSync(path,'utf8'));await db.exec(readFileSync(path,'utf8'));
    const t='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002',user='20000000-0000-4000-8000-000000000001';
    await db.query("insert into tenants(id,name,phone)values($1,'A','1111111'),($2,'B','2222222')",[t,other]);
    await db.query("insert into tenant_users values($1,$2,'owner')",[t,user]);
    await db.query("insert into notification_settings(tenant_id,time_zone)values($1,'America/New_York')",[t]);
    await db.query('insert into tenant_usage_limits(tenant_id,messages_per_month,voice_minutes_per_month)values($1,5,1)',[t]);
    const admit=async(key:string,messages=1,voice=0,now='2026-10-01T03:59:00Z',tenant=t)=>{
      const r=await db.query<{v:{allowed:boolean;duplicate:boolean;month:string;messages_used:number}}>('select admit_tenant_usage($1,$2,$3,$4,500,0,$5) as v',[tenant,key,messages,voice,now]);return r.rows[0]!.v;
    };
    await db.exec('set role service_role');
    for(let i=0;i<4;i++)assert.equal((await admit(`m${i}`)).allowed,true);
    assert.equal((await admit('m0')).duplicate,true);
    const warning=await db.query<{stage:string}>("select payload->>'stage' as stage from scheduled_jobs");assert.deepEqual(warning.rows,[{stage:'messages_80'}]);
    const burst=await Promise.all(Array.from({length:10},(_,i)=>admit(`burst${i}`)));
    assert.equal(burst.filter(r=>r.allowed).length,1);
    assert.equal((await admit('one-more')).allowed,false);
    assert.equal((await db.query("select * from scheduled_jobs where payload->>'stage'='messages_100'")).rows.length,1);
    assert.equal((await admit('new-month',1,0,'2026-10-01T04:00:00Z')).messages_used,1);
    assert.equal((await admit('other-month',1,0,'2026-10-01T04:00:00Z',other)).messages_used,1);
    assert.equal((await admit('voice-48',0,48,'2026-10-01T04:00:00Z')).allowed,true);
    assert.equal((await admit('voice-too-large',0,13,'2026-10-01T04:00:00Z')).allowed,false);
    assert.equal((await admit('voice-12',0,12,'2026-10-01T04:00:00Z')).allowed,true);
    assert.equal((await admit('voice-over',0,1,'2026-10-01T04:00:00Z')).allowed,false);
    const summary=await db.query<{v:any}>('select tenant_usage_summary($1,500,0,$2) as v',[t,'2026-10-01T04:00:00Z']);
    assert.equal(summary.rows[0]!.v.messages_used,1);assert.equal(summary.rows[0]!.v.voice_minutes_used,1);assert.equal(summary.rows[0]!.v.time_zone,'America/New_York');
    await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);await db.exec('set role authenticated');
    const own=await db.query<{tenant_id:string}>('select tenant_id from tenant_monthly_usage');assert.ok(own.rows.every(r=>r.tenant_id===t));
    await assert.rejects(db.query('update tenant_usage_limits set messages_per_month=999999'),/permission denied/);
    await assert.rejects(db.query('delete from usage_events'),/permission denied/);
    await assert.rejects(db.query("select admit_tenant_usage($1,'hack',1,0,99999,0)",[t]),/permission denied/);
    await db.exec('reset role');await db.exec('set role anon');await assert.rejects(db.query('select * from tenant_monthly_usage'),/permission denied/);
  }finally{await db.close();}
});
