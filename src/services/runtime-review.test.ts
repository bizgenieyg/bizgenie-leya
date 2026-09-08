import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registry } from '../agents/index.js';
import { AgentRegistry } from '../agents/registry.js';
import { validateRuntimePatch } from './runtime-settings.service.js';
import { renderText } from './templates.service.js';
import { activeElapsedMs } from './escalation.service.js';
import { reserveFailureAlert } from './alert-throttle.js';
import type { OwnerSettings } from './owner-settings.service.js';
const settings:OwnerSettings={owner_phone:null,owner_chat_id:null,mode:'mute_all',quiet_hours_start:null,quiet_hours_end:null,auto_replies_paused:false};
test('cheap intent routing, ambiguous model only, disabled agents and runtime overrides',async()=>{
 let calls=0;const ai={async generateReply(){calls++;return{text:'SALE'};}};
 assert.equal((await registry.route('Какая цена?',settings,ai))?.name,'SALE');assert.equal(calls,0);
 assert.equal((await registry.route('Есть проблема',settings,ai))?.name,'SUPPORT');assert.equal(calls,0);
 assert.equal((await registry.route('Привет',settings,ai))?.name,'SUPPORT');assert.equal(calls,0);
 assert.equal((await registry.route('Проблема с ценой',settings,ai))?.name,'SALE');assert.equal(calls,1);
 assert.equal((await registry.route('Какая цена?',{...settings,behavior:{enabled_agents:['SUPPORT']}},ai))?.name,'SUPPORT');
 assert.equal((await registry.route('специальное слово',{...settings,behavior:{agent_overrides:{SALE:{keywords:['специальное'],systemPrompt:'custom'}}}},ai))?.systemPrompt,'custom');
 const isolated=new AgentRegistry().register({name:'TEST',priority:1,signals:[/test/],systemPrompt:'test',actions:['answerFromKnowledge'],enabledByDefault:true,execute:core=>core.answerFromKnowledge()});
 const a=await isolated.route('test',{...settings,behavior:{enabled_agents:['TEST'],default_agent:'TEST'}},null);let executed=false;await a?.execute({async answerFromKnowledge(){executed=true;}});assert.equal(executed,true);
});
test('templates reject unknown placeholders, runtime rendering removes unsafe markup',()=>{
 assert.throws(()=>validateRuntimePatch({templates:{'client.waiting':{ru:'{unknown}'}}}));
 assert.throws(()=>validateRuntimePatch({warning_percent:101}));
 assert.throws(()=>validateRuntimePatch({tenantId:'other'}));
 const text=renderText({...settings,templates:{'client.owner_answer':{ru:'Ассистент: {answer}'}}},'client.owner_answer','ru',{answer:'<secret>{placeholder} да'});
 assert.doesNotMatch(text,/[<>{}]/);assert.match(text,/Ассистент/);
});
test('quiet-hour accounting excludes a DST-changing Jerusalem night',()=>{
 const quiet={mode:'mute_all',quiet_hours_start:'20:00',quiet_hours_end:'09:00',time_zone:'Asia/Jerusalem'};
 assert.equal(activeElapsedMs(quiet,new Date('2026-10-24T16:00:00Z'),new Date('2026-10-25T08:00:00Z')),2*3600000);
});
test('failure alert reservation persists across requests, respects interval and concurrent callers',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'leya-alert-'));
 try{assert.equal((await Promise.all(Array.from({length:10},()=>reserveFailureAlert('tenant',60000,100000,dir)))).filter(Boolean).length,1);
 assert.equal(await reserveFailureAlert('tenant',60000,110000,dir),false);assert.equal(await reserveFailureAlert('tenant',60000,160000,dir),true);
 assert.equal(await reserveFailureAlert('other',60000,110000,dir),true);
 }finally{await rm(dir,{recursive:true,force:true});}
});
