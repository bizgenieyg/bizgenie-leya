import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const migration='supabase/migrations/20260910100000_037_plans_and_tenant_usage_defaults.sql';

test('037 provisions plan limits and backfills existing tenants without overwriting values',async()=>{
  const db=new PGlite();
  try{
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
      create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to anon,authenticated,service_role;
      create table tenant_users(tenant_id uuid,user_id uuid,role text);grant select on tenant_users to authenticated;`);
    await db.exec(readFileSync('supabase/migrations/001_phase1_schema.sql','utf8').replace('create extension if not exists pgcrypto;',''));
    await db.exec(readFileSync('supabase/migrations/004_admin_onboarding_rls.sql','utf8'));
    await db.exec(readFileSync('supabase/migrations/20260908114713_024_owner_escalation_workflow.sql','utf8'));
    await db.exec(readFileSync('supabase/migrations/20260908164604_025_tenant_usage_limits.sql','utf8'));
    await db.exec(readFileSync('supabase/migrations/20260908174719_026_runtime_behavior_and_agents.sql','utf8'));
    await db.exec(readFileSync('supabase/migrations/20260909041638_027_system_tenant_settings_and_calendar.sql','utf8'));
    await db.exec(readFileSync('supabase/migrations/20260909120000_031_usage_timezone_offset_fix.sql','utf8'));
    await db.exec(`create table system_config(key text primary key,value jsonb not null,updated_at timestamptz default now());
      insert into system_config values('signup_default_plan','"starter"'),('max_tenants_per_owner','1');`);
    const missing='10000000-0000-4000-8000-000000000001',legacy='10000000-0000-4000-8000-000000000002';
    await db.query("insert into tenants(id,name,tier,status)values($1,'Missing','starter','active'),($2,'Legacy','starter','active')",[missing,legacy]);
    await db.query('insert into tenant_usage_limits(tenant_id,messages_per_month,voice_minutes_per_month,warning_percent)values($1,500,null,null)',[legacy]);

    await db.exec(readFileSync(migration,'utf8'));

    const basic=await db.query<{code:string;display_name:string;messages_per_month:number;voice_minutes_per_month:number;warning_percent:number}>("select code,display_name,messages_per_month,voice_minutes_per_month,warning_percent from plans where code='basic'");
    assert.deepEqual(basic.rows,[{code:'basic',display_name:'Базовый',messages_per_month:500,voice_minutes_per_month:60,warning_percent:80}]);
    const backfilled=await db.query<any>('select tenant_id,plan,messages_per_month,voice_minutes_per_month,warning_percent,messages_overridden from tenant_usage_limits order by tenant_id');
    assert.deepEqual(backfilled.rows.map(r=>({...r,tenant_id:String(r.tenant_id)})),[
      {tenant_id:missing,plan:'basic',messages_per_month:500,voice_minutes_per_month:60,warning_percent:80,messages_overridden:false},
      {tenant_id:legacy,plan:'basic',messages_per_month:500,voice_minutes_per_month:60,warning_percent:80,messages_overridden:true},
    ]);

    const user='20000000-0000-4000-8000-000000000001';
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);
    const created=await db.query<{id:string}>("select create_tenant_with_owner('Ника','Ника','ru') as id");
    const row=await db.query<any>('select l.plan,l.messages_per_month,l.voice_minutes_per_month,l.warning_percent,l.messages_overridden,l.voice_overridden,l.warning_overridden from tenant_usage_limits l where tenant_id=$1',[created.rows[0]!.id]);
    assert.deepEqual(row.rows,[{plan:'basic',messages_per_month:500,voice_minutes_per_month:60,warning_percent:80,messages_overridden:false,voice_overridden:false,warning_overridden:false}]);
    await db.query("update plans set messages_per_month=700 where code='basic'");
    const inherited=await db.query<{messages_per_month:number}>('select messages_per_month from effective_tenant_usage_limits($1)',[created.rows[0]!.id]);
    const overridden=await db.query<{messages_per_month:number}>('select messages_per_month from effective_tenant_usage_limits($1)',[legacy]);
    assert.equal(inherited.rows[0]!.messages_per_month,700);
    assert.equal(overridden.rows[0]!.messages_per_month,500);
    await db.query("update plans set messages_per_month=500 where code='basic'");
    assert.equal((await db.query<{value:string}>("select value#>>'{}' as value from system_config where key='signup_default_plan'")).rows[0]!.value,'basic');

    await db.exec(readFileSync('supabase/migrations/20260910110000_038_plan_integrity_and_pilot.sql','utf8'));
    assert.equal((await db.query<{value:string}>("select value#>>'{}' as value from system_config where key='signup_default_plan'")).rows[0]!.value,'pilot');
    assert.equal((await db.query<{count:number}>('select count(*)::int as count from tenant_usage_limits where plan<>\'pilot\'')).rows[0]!.count,0);
    assert.equal((await db.query<{messages_overridden:boolean}>('select messages_overridden from tenant_usage_limits where tenant_id=$1',[legacy])).rows[0]!.messages_overridden,false);
    await assert.rejects(db.query("update tenant_usage_limits set plan='missing' where tenant_id=$1",[legacy]),/foreign key/);
    await assert.rejects(db.query("update system_config set value='\"missing\"' where key='signup_default_plan'"),/signup_default_plan/);
    await db.query("update plans set code='pilot-renamed' where code='pilot'");
    assert.equal((await db.query<{plan:string}>('select plan from tenant_usage_limits where tenant_id=$1',[legacy])).rows[0]!.plan,'pilot-renamed');
    assert.equal((await db.query<{value:string}>("select value#>>'{}' as value from system_config where key='signup_default_plan'")).rows[0]!.value,'pilot-renamed');
    const unlimited=await db.query<{v:{allowed:boolean;unlimited:boolean} }>("select admit_tenant_usage($1,'pilot-test',1,999999,0,0,0,now()) as v",[legacy]);
    assert.equal(unlimited.rows[0]!.v.allowed,true);assert.equal(unlimited.rows[0]!.v.unlimited,true);
    assert.equal((await db.query<{count:number}>('select count(*)::int as count from scheduled_jobs where tenant_id=$1',[legacy])).rows[0]!.count,0);
    await db.exec('create index idx_messages_tenant_created_at on messages(tenant_id,created_at);create index idx_messages_tenant_created on messages(tenant_id,created_at);');
    await db.exec(readFileSync('supabase/migrations/20260910111000_039_drop_duplicate_messages_index.sql','utf8'));
    const indexes=await db.query<{indexname:string}>("select indexname from pg_indexes where schemaname='public' and tablename='messages' and indexname like 'idx_messages_tenant_created%'");
    assert.deepEqual(indexes.rows,[{indexname:'idx_messages_tenant_created'}]);
  }finally{await db.close();}
});
