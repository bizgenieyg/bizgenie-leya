import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registry } from '../agents/index.js';
import { AgentRegistry } from '../agents/registry.js';
import { behavior,normalizedSchedule,templates,validateRuntimePatch } from './runtime-settings.service.js';
import { renderText } from './templates.service.js';
import { activeElapsedMs,isWithinQuietHours } from './escalation.service.js';
import { reserveFailureAlert } from './alert-throttle.js';
import type { OwnerSettings } from './owner-settings.service.js';
import { BEHAVIOR_DEFAULTS } from '../config/behavior.js';
const settings:OwnerSettings={owner_phone:null,owner_chat_id:null,mode:'mute_all',quiet_hours_start:null,quiet_hours_end:null,auto_replies_paused:false};
test('cheap intent classification, model confidence, disabled agents and runtime overrides',async()=>{
 let calls=0;const ai={async generateReply(){calls++;return{text:'{"agent":"SALE","confidence":0.82}'};}};
 assert.equal((await registry.classify('Какая цена?',settings,ai)).agent?.name,'SALE');assert.equal(calls,0);
 assert.equal((await registry.classify('Есть проблема',settings,ai)).agent?.name,'SUPPORT');assert.equal(calls,0);
 assert.equal((await registry.classify('Привет',settings,ai)).agent?.name,'SALE');assert.equal(calls,1);
 assert.equal((await registry.classify('Проблема с ценой',settings,ai)).agent?.name,'SALE');assert.equal(calls,2);
 assert.equal((await registry.classify('Какая цена?',{...settings,behavior:{enabled_agents:['SUPPORT']}},ai)).agent,null);
 assert.equal((await registry.classify('специальное слово',{...settings,behavior:{agent_overrides:{SALE:{keywords:['специальное'],systemPrompt:'custom'}}}},ai)).agent?.systemPrompt,'custom');
 const isolated=new AgentRegistry().register({name:'TEST',priority:1,signals:[/test/],systemPrompt:'test',actions:['answerFromKnowledge'],enabledByDefault:true,execute:core=>core.answerFromKnowledge()});
 const a=(await isolated.classify('test',{...settings,behavior:{enabled_agents:['TEST']}},null)).agent;let executed=false;await a?.execute({async answerFromKnowledge(){executed=true;}});assert.equal(executed,true);
});
test('templates reject unknown placeholders, runtime rendering removes unsafe markup',()=>{
 assert.throws(()=>validateRuntimePatch({templates:{'client.waiting':{ru:'{unknown}'}}}));
 assert.throws(()=>validateRuntimePatch({warning_percent:80}),(error:any)=>error.status===403);
 assert.throws(()=>validateRuntimePatch({messages_per_month:999999}),(error:any)=>error.status===403);
 assert.throws(()=>validateRuntimePatch({plan:'unlimited'}),(error:any)=>error.status===403);
 assert.throws(()=>validateRuntimePatch({time_zone:'Etc/Anything'}));
 assert.throws(()=>validateRuntimePatch({tenantId:'other'}));
 const text=renderText({...settings,templates:{'client.owner_answer':{ru:'Ассистент: {answer}'}}},'client.owner_answer','ru',{answer:'<secret>{placeholder} да'});
 assert.doesNotMatch(text,/[<>{}]/);assert.match(text,/Ассистент/);
});
test('conversation behavior settings validate tenant overrides',()=>{
 const patch=validateRuntimePatch({auto_resume_hours:0,deferred_max_age_hours:12,context_message_count:10,context_retention_hours:48,intent_confidence_threshold:.8,route_stickiness_hours:24,reception_max_messages:0,campaign_routes:[{keyword:'AUDIT',agent:'SALE'}],source_routes:[{source:'catalog',agent:'SALE'}]});
 assert.equal(patch.behaviorPatch.intent_confidence_threshold,.8);assert.equal(patch.behaviorPatch.route_stickiness_hours,24);
 assert.throws(()=>validateRuntimePatch({auto_resume_hours:-1}));assert.throws(()=>validateRuntimePatch({context_message_count:0}));
 assert.throws(()=>validateRuntimePatch({default_agent:'SUPPORT'}));
 assert.doesNotThrow(()=>validateRuntimePatch({time_zone:'UTC+3'}));assert.doesNotThrow(()=>validateRuntimePatch({time_zone:'UTC-12'}));
 assert.equal(validateRuntimePatch({cabinet_language:'en'}).behaviorPatch.cabinet_language,'en');
 assert.doesNotThrow(()=>validateRuntimePatch({cabinet_language:'he'}));
 assert.throws(()=>validateRuntimePatch({cabinet_language:'de'}));
});
test('operator runtime settings remain accepted by the ADMIN_SECRET API validator',()=>{
 const patch=validateRuntimePatch({translate_owner_answer:true,escalation_remind_minutes:120,escalation_close_minutes:1440,auto_resume_hours:0,deferred_max_age_hours:12,context_message_count:10,context_retention_hours:48,intent_confidence_threshold:.75,route_stickiness_hours:24,reception_max_messages:0,campaign_routes:[],source_routes:[],templates:{'client.waiting':{ru:'Я уточню и вернусь с ответом.'}}});
 assert.equal(patch.notification.translate_owner_answer,true);
 assert.equal((patch.notification.templates as any)['client.waiting'].ru,'Я уточню и вернусь с ответом.');
 assert.equal(patch.behaviorPatch.escalation_remind_minutes,120);
 assert.deepEqual(patch.behaviorPatch.campaign_routes,[]);
});
test('legacy tenants receive every behavior and template default at runtime',()=>{
 const legacy={...settings,behavior:{campaign_routes:undefined,enabled_agents:null,weekly_schedule:{}},templates:{'client.waiting':{ru:'Свой текст'}}} as any;
 const normalized=behavior(legacy);for(const key of Object.keys(BEHAVIOR_DEFAULTS))assert.notEqual((normalized as any)[key],undefined);
 assert.deepEqual(normalized.campaign_routes,[]);assert.deepEqual(normalized.enabled_agents,['SALE','SUPPORT']);
 assert.equal(Object.keys(normalizedSchedule(legacy)).length,7);
 const catalog=templates(legacy);assert.equal(catalog['client.waiting']!.ru,'Свой текст');assert.ok(catalog['client.waiting']!.he);assert.ok(catalog['client.reception_question']!.ru);
});
test('weekly schedule and exceptions override legacy quiet hours in owner timezone',()=>{
 const base={mode:'mute_all',quiet_hours_start:'20:00',quiet_hours_end:'09:00',time_zone:'Asia/Jerusalem',behavior:{weekly_schedule:{
  '0':{mode:'working_day'},'1':{mode:'working_hours',start:'09:00',end:'18:00'},'2':{mode:'working_day'},'3':{mode:'working_day'},'4':{mode:'working_day'},'5':{mode:'working_day'},'6':{mode:'day_off'}}}};
 assert.equal(isWithinQuietHours(base as any,new Date('2026-09-07T05:59:00Z')),true);
 assert.equal(isWithinQuietHours(base as any,new Date('2026-09-07T06:00:00Z')),false);
 assert.equal(isWithinQuietHours(base as any,new Date('2026-09-12T12:00:00Z')),true);
 const exception={...base,exceptions:[{start_date:'2026-09-07',end_date:'2026-09-07',kind:'day_off',work_start:null,work_end:null,recurs_annually:false}]};
 assert.equal(isWithinQuietHours(exception as any,new Date('2026-09-07T10:00:00Z')),true);
 const annual={...base,exceptions:[{start_date:'2020-09-08',end_date:'2020-09-08',kind:'special_hours',work_start:'12:00',work_end:'14:00',recurs_annually:true}]};
 assert.equal(isWithinQuietHours(annual as any,new Date('2026-09-08T08:59:00Z')),true);
 assert.equal(isWithinQuietHours(annual as any,new Date('2026-09-08T09:00:00Z')),false);
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
