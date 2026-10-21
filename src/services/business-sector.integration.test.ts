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

test('Z8: «Настройки → Бизнес» saves business and owner names and owner_language; empty names are rejected',async()=>{
 const pg=await createTestDatabase();
 try{
  const db=pgliteDatabaseClient(pg);
  const id=((await db.from('tenants').insert({name:'Owner',business_name:'Studio',language:'ru',tier:'pilot',status:'active'}).select('id').single()).data as {id:string}).id;
  await pg.query('select public.ensure_tenant_usage_limits($1)',[id]);
  const before=await readRuntimeSettings(db,id);
  assert.deepEqual([before.business_name,before.owner_name,before.owner_language],['Studio','Owner','ru']);
  const after=await saveRuntimeSettings(db,id,{business_name:'  Ноготки ',owner_name:' Ира ',owner_language:'he'});
  assert.deepEqual([after.business_name,after.owner_name,after.owner_language],['Ноготки','Ира','he']);
  await assert.rejects(saveRuntimeSettings(db,id,{business_name:'  '}),/Invalid business_name/);
  await assert.rejects(saveRuntimeSettings(db,id,{owner_language:'fr'}),/Invalid language/);
 }finally{await pg.close();}
});
