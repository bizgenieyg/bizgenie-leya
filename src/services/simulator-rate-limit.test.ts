import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {reserveSimulatorCall} from './simulator-rate-limit.js';

test('concurrent simulator reservations do not report a false limit',async()=>{
 const root=await mkdtemp(join(tmpdir(),'leya-simulator-rate-'));
 try{
  const now=new Date('2026-09-14T10:00:00Z');
  const results=await Promise.all(Array.from({length:5},()=>reserveSimulatorCall('10000000-0000-4000-8000-000000000001',5,5,now,root)));
  assert.deepEqual(results.map(result=>result.allowed),[true,true,true,true,true]);
  assert.deepEqual(await reserveSimulatorCall('10000000-0000-4000-8000-000000000001',5,5,now,root),{allowed:false,period:'day'});
 }finally{await rm(root,{recursive:true,force:true});}
});
