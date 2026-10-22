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

test('Z9: one save writes tenants, assistant_profiles and notification_settings together; a rejected field saves nothing',async()=>{
 const pg=await createTestDatabase();
 try{
  const db=pgliteDatabaseClient(pg);
  const id=((await db.from('tenants').insert({name:'Owner',business_name:'Studio',language:'ru',tier:'pilot',status:'active'}).select('id').single()).data as {id:string}).id;
  await pg.query('select public.ensure_tenant_usage_limits($1)',[id]);
  await pg.query('insert into assistant_profiles(tenant_id,assistant_name) values($1,$2)',[id,'Leya']);
  await pg.query(`insert into notification_settings(tenant_id,time_zone,behavior) values($1,'Asia/Jerusalem',$2)`,[id,JSON.stringify({weekly_schedule:Object.fromEntries(Array.from({length:7},(_,i)=>[String(i),{mode:'working_day'}]))})]);
  const before=await readRuntimeSettings(db,id);
  assert.deepEqual([before.quiet_hours_start,before.quiet_hours_end,before.assistant_name],['','','Leya']);
  const after=await saveRuntimeSettings(db,id,{business_name:'Ноготки',assistant_name:' Мира ',polish_owner_answer:false,quiet_hours_start:'22:00',quiet_hours_end:'08:00'});
  assert.deepEqual([after.business_name,after.assistant_name,after.polish_owner_answer,after.quiet_hours_start,after.quiet_hours_end],['Ноготки','Мира',false,'22:00','08:00']);
  // «Не беспокоить» is the one availability setting: the stored weekly schedule no longer overrides it.
  const stored=(await pg.query<{weekly:unknown}>(`select behavior->'weekly_schedule' as weekly from notification_settings where tenant_id=$1`,[id])).rows[0];
  assert.equal(stored?.weekly,null);
  // The same start and end is rejected with a code, and nothing of that request is written.
  await assert.rejects(saveRuntimeSettings(db,id,{business_name:'Другое',quiet_hours_start:'10:00',quiet_hours_end:'10:00'}),(error:unknown)=>(error as {details?:{code?:string}}).details?.code==='quiet_hours_equal');
  await assert.rejects(saveRuntimeSettings(db,id,{assistant_name:'Новое',owner_language:'fr'}),/Invalid language/);
  const kept=await readRuntimeSettings(db,id);
  assert.deepEqual([kept.business_name,kept.assistant_name,kept.quiet_hours_start],['Ноготки','Мира','22:00']);
  // Off: both empty.
  const off=await saveRuntimeSettings(db,id,{quiet_hours_start:null,quiet_hours_end:null});
  assert.deepEqual([off.quiet_hours_start,off.quiet_hours_end],['','']);
 }finally{await pg.close();}
});
