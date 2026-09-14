import assert from 'node:assert/strict';
import test from 'node:test';
import {createTestDatabase} from './test-support/pglite-harness.js';

test('tenant provisioning starts with customer replies paused',async()=>{
  const pg=await createTestDatabase();
  try{
    const userId='10000000-0000-4000-8000-000000000099';
    await pg.query('insert into auth.users(id) values($1)',[userId]);
    await pg.query("select set_config('request.jwt.claim.sub',$1,false)",[userId]);
    const created=await pg.query<{tenant_id:string}>("select public.create_tenant_with_owner('Owner','Safe business','ru') as tenant_id");
    const state=await pg.query<{auto_replies_paused:boolean}>('select auto_replies_paused from notification_settings where tenant_id=$1',[created.rows[0]!.tenant_id]);
    assert.equal(state.rows[0]?.auto_replies_paused,true);
  }finally{await pg.close();}
});
