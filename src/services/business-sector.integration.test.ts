import assert from 'node:assert/strict';
import test from 'node:test';
import {createTestDatabase,pgliteDatabaseClient} from './test-support/pglite-harness.js';
import {readRuntimeSettings,saveRuntimeSettings} from './runtime-settings.service.js';

test('owner settings save and read the nullable business sector on the real schema',async()=>{
 const pg=await createTestDatabase();
 try{
  const db=pgliteDatabaseClient(pg);
  const tenant=await db.from('tenants').insert({name:'Owner',business_name:'Studio',language:'ru',tier:'pilot',status:'active'}).select('id').single();
  assert.equal(tenant.error,null);
  const id=(tenant.data as {id:string}).id;
  await pg.query('select public.ensure_tenant_usage_limits($1)',[id]);
  assert.equal((await readRuntimeSettings(db,id)).business_sector,null);
  assert.equal((await saveRuntimeSettings(db,id,{business_sector:'  косметолог  '})).business_sector,'косметолог');
  assert.equal((await readRuntimeSettings(db,id)).business_sector,'косметолог');
  assert.equal((await saveRuntimeSettings(db,id,{business_sector:''})).business_sector,null);
 }finally{await pg.close();}
});
