import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { DatabaseClient } from '../db/supabase.js';
import type { WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { conversationPaused, createEscalation, handleOwnerMessage, runDueScheduledEscalations } from './owner-workflow.service.js';
import { saveOwnerSettings, type OwnerSettings } from './owner-settings.service.js';
import { isWithinQuietHours, nextQuietHoursEnd } from './escalation.service.js';
import { observeOwnerOutgoing } from './outgoing-owner.service.js';
import { clientText, isDeferredAnswer, replyId } from '../utils/assistant-text.js';
process.env.SUPABASE_URL='https://database.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY='test-only';
process.env.GEMINI_API_KEY='';
const tenant='123e4567-e89b-42d3-a456-426614174000';
const owner='972500000002@c.us';
const customer='261885798707406@lid';
const defaults:OwnerSettings={owner_phone:'972500000002',owner_chat_id:owner,mode:'mute_all',time_zone:'Asia/Jerusalem',quiet_hours_start:null,quiet_hours_end:null,auto_replies_paused:false};
// Fluent in-memory PostgREST double, including conditional claims and tenant predicates.
function harness() {
 let quotaAllowed=true;let admitted=0;
  type Row=Record<string,any>;
  const tables:Record<string,Row[]>={notification_settings:[{tenant_id:tenant,...defaults}],conversations:[{id:'conversation',tenant_id:tenant,client_id:'client',status:'active',bot_paused:false}],escalations:[],unrecognized_routes:[],scheduled_jobs:[],knowledge_items:[],
    tenants:[{id:tenant,name:'Business',phone:null,status:'active',language:'ru'}],whatsapp_instances:[{tenant_id:tenant,session_name:'session'}],clients:[{id:'client',tenant_id:tenant,phone:customer,name:'Клиент'}],assistant_profiles:[]};
  const db={from(table:string){
    const filters:((r:Row)=>boolean)[]=[];let action='read',values:Row|undefined;let single=false;let ran=false;let result:any;
    const q:any={select(){return q;},eq(k:string,v:unknown){filters.push(r=>r[k]===v);return q;},is(k:string,v:unknown){filters.push(r=>r[k]===v||r[k]===undefined&&v===null);return q;},in(k:string,v:unknown[]){filters.push(r=>v.includes(r[k]));return q;},contains(k:string,v:any){filters.push(r=>Array.isArray(v)?v.every((x:string)=>r[k]?.includes(x)):Object.entries(v).every(([x,y])=>r[k]?.[x]===y));return q;},lte(k:string,v:string){filters.push(r=>r[k]<=v);return q;},lt(k:string,v:string){filters.push(r=>r[k]<v);return q;},gte(k:string,v:string){filters.push(r=>r[k]>=v);return q;},not(){return q;},order(){return q;},limit(){return q;},
      update(v:Row){action='update';values=v;return q;},insert(v:Row){action='insert';values=v;return q;},upsert(v:Row){action='upsert';values=v;return q;},
      delete(){action='delete';return q;},
      maybeSingle(){single=true;return q;},single(){single=true;return q;},then(resolve:any,reject:any){try{if(!ran){ran=true;const rows=tables[table]??(tables[table]=[]);let found=rows.filter(r=>filters.every(f=>f(r)));
        if(action==='insert'){const row={id:`row-${rows.length}`,status:'queued',owner_message_ids:[],learning_message_ids:[],learning_state:'none',...values};rows.push(row);found=[row];}
        if(action==='update')found.forEach(r=>Object.assign(r,values));
        if(action==='delete')for(const row of found){const i=rows.indexOf(row);if(i>=0)rows.splice(i,1);}
        if(action==='upsert'){let row=rows.find(r=>r.tenant_id===values?.tenant_id);if(row)Object.assign(row,values);else{row={...values};rows.push(row);}found=[row];}
        result={data:single?(found[0]??null):found.map(r=>({...r})),error:null};}
        return Promise.resolve(result).then(resolve,reject);
      }catch(e){return Promise.reject(e).then(resolve,reject);}}
    };return q;
  },async rpc(_name:string,args:Row){if(_name==='admit_tenant_usage'){if(quotaAllowed)admitted++;return {data:{allowed:quotaAllowed,duplicate:false},error:null};}const e=tables.escalations!.find(r=>r.tenant_id===args.p_tenant_id&&r.id===args.p_escalation_id)!;if(e.status!=='delivered')return {error:{}};
    if(!e.knowledge_item_id){tables.knowledge_items!.push({tenant_id:tenant,question:e.question,answer:e.answer});e.knowledge_item_id='knowledge';e.learning_state='saved';}return {data:'knowledge',error:null};}} as unknown as DatabaseClient;
  const sent:{chatId:string;text:string;id:string;replyTo?:string}[]=[];
  let failClient=false;
  const provider:WhatsAppProvider={async getSessionStatus(){return{status:'WORKING',me:{id:'972500000009@c.us',lid:'99999999@lid'}};},async sendMessage(input){if(failClient&&input.chatId===customer)throw new Error('network');const id=`true_${input.chatId}_MSG${sent.length}`;sent.push({...input,id});return{id};}};
  return {db,tables,sent,provider,admissions:()=>admitted,deny:()=>{quotaAllowed=false;},fail:()=>{failClient=true;}};
}
const input={tenant_id:tenant,conversation_id:'conversation',client_chat_id:customer,client_name:'Тестовый клиент',question:'Можно завтра?',session:'session',inbound_id:'incoming'};

test('owner reply: short GOWS ID, delivery before closure, quoted confirmation only and tenant isolation',async()=>{
  const h=harness();await createEscalation(h.db,h.provider,input,defaults);
  assert.equal(h.sent.length,2);assert.match(h.sent[0]!.text,/ассистент владельца/);assert.equal(h.sent[1]!.chatId,owner);
  const e=h.tables.escalations![0]!;assert.equal(e.status,'pending');
  assert.match(h.sent[1]!.text,/Тестовый клиент/);
  await handleOwnerMessage(h.db,h.provider,'other-tenant','session',owner,'Ответ',replyId(h.sent[1]!.id),defaults);
  assert.equal(e.status,'pending');assert.equal(h.sent.length,2);
  await handleOwnerMessage(h.db,h.provider,tenant,'session',owner,'Завтра отвечу',e.owner_message_ids[0],defaults);
  assert.equal(e.status,'pending');assert.equal(h.tables.knowledge_items!.length,0);
  await handleOwnerMessage(h.db,h.provider,tenant,'session',owner,'Да, можно',e.owner_message_ids[0],defaults);
  assert.equal(e.status,'delivered');assert.ok(e.client_message_id);assert.equal(h.sent.at(-2)!.chatId,customer);
  assert.equal(h.sent.at(-2)!.replyTo,undefined);
  assert.match(h.sent.at(-2)!.text,/Передаю ответ владельца/);assert.equal(h.tables.knowledge_items!.length,0);
  const prompt=e.learning_message_ids[0];
  assert.equal(await handleOwnerMessage(h.db,h.provider,tenant,'session',customer,'Да',prompt,defaults),false);
  assert.equal(h.tables.knowledge_items!.length,0);
  await handleOwnerMessage(h.db,h.provider,tenant,'session',owner,'Да',prompt,defaults);
  await handleOwnerMessage(h.db,h.provider,tenant,'session',owner,'Да',prompt,defaults);
  assert.equal(h.tables.knowledge_items!.length,1);assert.equal(e.learning_state,'saved');
});
test('failed client delivery leaves escalation open and never offers learning',async()=>{
  const h=harness();await createEscalation(h.db,h.provider,input,defaults);h.fail();
  const e=h.tables.escalations![0]!;
  await handleOwnerMessage(h.db,h.provider,tenant,'session',owner,'Ответ',e.owner_message_ids[0],defaults);
  assert.equal(e.status,'delivery_uncertain');assert.equal(e.learning_state,'none');assert.equal(h.tables.knowledge_items!.length,0);
});
test('takeover, tenant pause and explicit resume remain separate',async()=>{
  const h=harness();await createEscalation(h.db,h.provider,input,defaults);const e=h.tables.escalations![0]!;
  await handleOwnerMessage(h.db,h.provider,tenant,'session',owner,'Беру на себя',e.owner_message_ids[0],defaults);
  assert.equal(h.tables.conversations![0]!.bot_paused,true);
  await handleOwnerMessage(h.db,h.provider,tenant,'session',owner,'Ответ',e.owner_message_ids[0],defaults);assert.equal(e.status,'pending');
  await handleOwnerMessage(h.db,h.provider,tenant,'session',owner,'Пауза всё',null,defaults);
  assert.equal(h.tables.notification_settings![0]!.auto_replies_paused,true);
  await handleOwnerMessage(h.db,h.provider,tenant,'session',owner,'Продолжить всё',null,defaults);
  assert.equal(h.tables.conversations![0]!.bot_paused,true);
  await handleOwnerMessage(h.db,h.provider,tenant,'session',owner,'Продолжить',e.owner_message_ids[0],defaults);
  assert.equal(h.tables.conversations![0]!.bot_paused,false);
});
test('manual fromMe send pauses dialogue and closes pending escalation; API send is ignored',async()=>{
 const h=harness();h.tables.escalations!.push({id:'e',...input,status:'queued',created_at:'2026-09-08T10:00:00Z'});
 const body={event:'message',payload:{id:'manual-1',from:'972500000009@c.us',to:customer,fromMe:true,source:'app',body:'Ответ владельца',_data:{Info:{IsFromMe:true,Chat:customer}}}};
 assert.equal(await observeOwnerOutgoing(h.db,tenant,body,new Date('2026-09-08T20:00:00Z')),true);
 assert.equal(h.tables.conversations![0]!.bot_paused,true);assert.equal(h.tables.escalations![0]!.status,'resolved_by_owner');
 assert.equal(await observeOwnerOutgoing(h.db,tenant,{...body,payload:{...body.payload,id:'api-1',source:'api'}},new Date()),false);
});
test('automatic resume is disabled by default and enabled after configured inactivity',async()=>{
 const h=harness(),row=h.tables.conversations![0]!;row.bot_paused=true;row.owner_last_activity_at='2026-09-08T10:00:00Z';
 assert.equal(await conversationPaused(h.db,tenant,row.id,defaults,new Date('2026-09-09T10:00:00Z')),true);
 assert.equal(await conversationPaused(h.db,tenant,row.id,{...defaults,behavior:{auto_resume_hours:12}},new Date('2026-09-09T10:00:00Z')),false);assert.equal(row.bot_paused,false);
});
test('quiet queue uses Jerusalem time, delivers each once across concurrent schedulers',async()=>{
  const h=harness();const night={...defaults,quiet_hours_start:'20:00',quiet_hours_end:'09:00'};
  assert.equal(isWithinQuietHours(night,new Date('2026-09-08T18:00:00Z')),true);
  assert.equal(nextQuietHoursEnd(night,new Date('2026-09-08T18:00:00Z')).toISOString(),'2026-09-09T06:00:00.000Z');
  assert.equal(nextQuietHoursEnd(night,new Date('2026-10-24T18:00:00Z')).toISOString(),'2026-10-25T07:00:00.000Z');
  h.tables.notification_settings![0]={tenant_id:tenant,...night};
  h.tables.escalations!.push({id:'e',...input,status:'queued',owner_message_ids:[],learning_state:'none'});
  h.tables.scheduled_jobs!.push({id:'j',tenant_id:tenant,job_type:'owner_escalation',payload:{escalation_id:'e'},status:'pending',scheduled_at:'2026-09-08T00:00:00Z'});
  await runDueScheduledEscalations(h.db,()=>h.provider,new Date('2026-09-08T18:00:00Z'));assert.equal(h.sent.length,0);
  await Promise.all([runDueScheduledEscalations(h.db,()=>h.provider,new Date('2026-09-09T06:00:00Z')),runDueScheduledEscalations(h.db,()=>h.provider,new Date('2026-09-09T06:00:00Z'))]);
  assert.equal(h.sent.length,1);assert.equal(h.tables.escalations![0]!.status,'pending');
});
test('due escalation is cancelled after owner activity and expires after maximum age',async()=>{
 for(const kind of ['owner','expired']){const h=harness(),created='2026-09-08T00:00:00Z';h.tables.notification_settings![0]!.behavior={deferred_max_age_hours:12};h.tables.conversations![0]!.owner_last_activity_at=kind==='owner'?'2026-09-08T01:00:00Z':null;
  h.tables.escalations!.push({id:'e',...input,status:'queued',created_at:created,owner_message_ids:[],learning_state:'none'});h.tables.scheduled_jobs!.push({id:'j',tenant_id:tenant,job_type:'owner_escalation',payload:{escalation_id:'e'},status:'pending',scheduled_at:created});
  await runDueScheduledEscalations(h.db,()=>h.provider,new Date('2026-09-08T13:00:00Z'));assert.equal(h.sent.length,0);assert.equal(h.tables.escalations![0]!.status,kind==='owner'?'resolved_by_owner':'expired');
 }
});
test('owner phone must differ from session; one-time code binds LID and never guesses digits',async()=>{
  const h=harness();
  await assert.rejects(saveOwnerSettings(h.db,tenant,{phone:'972500000009'},{id:'972500000009@c.us'}),/отличаться/);
  const result=await saveOwnerSettings(h.db,tenant,{phone:'972500000002',timeZone:'Asia/Jerusalem'},{id:'972500000009@c.us'});
  const settings=h.tables.notification_settings![0] as OwnerSettings;
  await handleOwnerMessage(h.db,h.provider,tenant,'session','88888888@lid',result.pairingCommand,null,settings);
  assert.equal(settings.owner_chat_id,'88888888@lid');assert.equal(settings.owner_pairing_hash,null);
  await handleOwnerMessage(h.db,h.provider,tenant,'session','77777777@lid',result.pairingCommand,null,settings);
  assert.equal(settings.owner_chat_id,'88888888@lid');
});
test('complete real GOWS client and owner reply payloads traverse worker filters through delivery',async()=>{
  const {handleWebhookEvent}=await import('../workers/webhook.worker.js');const h=harness();
  const body=JSON.parse(readFileSync('src/services/fixtures/gows-incoming-lid.json','utf8'));
  body.payload.from=customer;body.payload._data.Info.Chat=customer;body.payload.body='Неизвестный вопрос';
  await handleWebhookEvent(tenant,body,h.db,h.provider,null);
  await handleWebhookEvent(tenant,body,h.db,h.provider,null);
  const e=h.tables.escalations![0]!;assert.equal(e.status,'pending');assert.equal(e.client_name,body.payload._data.Info.PushName);
  h.tables.notification_settings![0]!.owner_chat_id='88888888@lid';
  const reply=structuredClone(body);reply.payload.from='88888888@lid';reply.payload._data.Info.Chat=reply.payload.from;reply.payload.body='Ответ владельца';reply.payload.replyTo={id:e.owner_message_ids[0]};
  await handleWebhookEvent(tenant,reply,h.db,h.provider,null);assert.equal(e.status,'delivered');
  h.tables.notification_settings![0]!.auto_replies_paused=true;const count=h.sent.length;
  await handleWebhookEvent(tenant,body,h.db,h.provider,{async generateReply(){throw new Error('must not call AI');}});assert.equal(h.sent.length,count);
});
test('observeOwnerOutgoing guard #1 is idempotent on a re-delivered waha_msg_id',async()=>{
 const h=harness();h.tables.escalations!.push({id:'e',...input,status:'queued',created_at:'2026-09-08T10:00:00Z'});
 const body={event:'message',payload:{id:'manual-7',from:'972500000009@c.us',to:customer,fromMe:true,source:'app',body:'Ответ владельца',_data:{Info:{IsFromMe:true,Chat:customer}}}};
 assert.equal(await observeOwnerOutgoing(h.db,tenant,body,new Date('2026-09-08T20:00:00Z')),true);
 const rows=h.tables.messages!.length;
 h.tables.conversations![0]!.bot_paused=false;
 assert.equal(await observeOwnerOutgoing(h.db,tenant,body,new Date('2026-09-08T20:05:00Z')),false);
 assert.equal(h.tables.messages!.length,rows,'no duplicate stored message');
 assert.equal(h.tables.conversations![0]!.bot_paused,false,'no repeated pause/close side effects');
});

test('returning contact with assistant_introduced_at gets no repeated greeting',async()=>{
 const {handleWebhookEvent}=await import('../workers/webhook.worker.js');
 const intro='Я ассистент владельца. Открыто с 9 до 18.';
 const ai={async generateReply(i:{systemPrompt:string}){return{text:i.systemPrompt.includes('классификатор намерений')?'{"agent":"SALE","confidence":0.9}':intro};}};
 const run=async(introduced:boolean)=>{
  const h=harness();
  h.tables.knowledge_items!.push({tenant_id:tenant,type:'faq',question:'Есть ли доставка в Хайфу?',answer:'Да, доставка есть.',active:true});
  h.tables.conversations![0]!.assistant_introduced_at=introduced?'2026-09-01T00:00:00Z':null;
  const body={event:'message',payload:{from:customer,fromMe:false,hasMedia:false,body:'Сколько стоит доставка?',author:null,replyTo:null,_data:{Info:{Chat:customer,PushName:'Клиент'}}}};
  await handleWebhookEvent(tenant,body,h.db,h.provider,ai);
  return h.sent.at(-1)?.text;
 };
 assert.equal(await run(true),'Открыто с 9 до 18.');
 assert.equal(await run(false),intro);
});

test('assistant formatting strips placeholders and defer detection does not reject substantive tomorrow answer',()=>{
  assert.equal(clientText('Ответ <имя> без > скобок'),'Ответ  без  скобок');
  assert.equal(isDeferredAnswer('Завтра доставка с 9 до 18'),false);
  assert.equal(isDeferredAnswer('позже'),true);
});

test('owner can pause any dialogue without an escalation; foreign dialogue cannot be changed',async()=>{
  const h=harness();const id='30000000-0000-4000-8000-000000000001';h.tables.conversations![0]!.id=id;
  await handleOwnerMessage(h.db,h.provider,tenant,'session',owner,`Беру на себя ${id}`,null,defaults);
  assert.equal(h.tables.conversations![0]!.bot_paused,true);
  await handleOwnerMessage(h.db,h.provider,'another-tenant','session',owner,`Продолжить диалог ${id}`,null,defaults);
  assert.equal(h.tables.conversations![0]!.bot_paused,true);
  await handleOwnerMessage(h.db,h.provider,tenant,'session',owner,`Продолжить диалог ${id}`,null,defaults);
  assert.equal(h.tables.conversations![0]!.bot_paused,false);
});

test('owner timezone changes quiet hours and client time converts across calendar days',async()=>{
  const {waitingText}=await import('../utils/assistant-text.js');
  const {clientTimeZoneCommand}=await import('../utils/time-zone.js');
  const settings={...defaults,time_zone:'America/New_York',quiet_hours_start:'20:00',quiet_hours_end:'09:00'};
  const now=new Date('2026-09-09T02:00:00Z');
  assert.equal(isWithinQuietHours(settings,now),true);
  const end=nextQuietHoursEnd(settings,now);
  assert.equal(end.toISOString(),'2026-09-09T13:00:00.000Z');
  const message=waitingText('Вопрос',{at:end,ownerZone:settings.time_zone,clientZone:'Asia/Tokyo'});
  assert.match(message,/22:00/);assert.match(message,/ваше местное время/);
  assert.match(waitingText('Вопрос',{at:end,ownerZone:settings.time_zone}),/09:00.*время владельца/);
  assert.equal(clientTimeZoneCommand('Часовой пояс Europe/Berlin'),'Europe/Berlin');
  assert.equal(clientTimeZoneCommand('Часовой пояс invented/Place'),null);
});

test('owner answer translation preserves original for learning and falls back safely',async()=>{
  const {translateOwnerAnswer}=await import('./ai-fallback.service.js');let calls=0;
  const ai={async generateReply(input:{systemPrompt:string;userMessage:string}){calls++;assert.equal(JSON.parse(input.userMessage).ownerAnswer,'Доставка завтра');return {text:'Delivery is tomorrow.'};}};
  assert.equal(await translateOwnerAnswer('When is delivery?','Доставка завтра',ai),'Delivery is tomorrow.');
  assert.equal(await translateOwnerAnswer('Когда доставка?','Доставка завтра',ai),'Доставка завтра');assert.equal(calls,1);
  assert.equal(await translateOwnerAnswer('When?','Доставка завтра',null),'Доставка завтра');
});

test('owner translation is opt-in: disabled makes zero model calls',async()=>{
 for(const enabled of [false,true]){
  const h=harness();const settings={...defaults,translate_owner_answer:enabled};await createEscalation(h.db,h.provider,input,settings);const e=h.tables.escalations![0]!;let calls=0;
  await handleOwnerMessage(h.db,h.provider,tenant,'session',owner,'Yes, available',e.owner_message_ids[0],settings,{async generateReply(){calls++;return{text:'Да, доступно'};}});
  assert.equal(calls,enabled?1:0);assert.match(h.sent.at(-2)!.text,enabled?/Да, доступно/:/Yes, available/);
 }
});
test('timeout reminder is once, quoted reply matches it, quiet hours do not count, closure follows delivery',async()=>{
 const {runEscalationTimeouts}=await import('./owner-workflow.service.js');
 const h=harness();const settings={...defaults,quiet_hours_start:'20:00',quiet_hours_end:'09:00',behavior:{escalation_remind_minutes:60,escalation_close_minutes:120}};
 h.tables.notification_settings![0]={tenant_id:tenant,...settings};
 h.tables.escalations!.push({id:'e',...input,status:'pending',owner_message_ids:['initial'],pending_since:'2026-09-08T16:30:00Z',learning_state:'none'});
 await runEscalationTimeouts(h.db,()=>h.provider,new Date('2026-09-09T06:29:00Z'));assert.equal(h.sent.length,0);
 await runEscalationTimeouts(h.db,()=>h.provider,new Date('2026-09-09T06:30:00Z'));assert.equal(h.sent.length,1);assert.equal(h.tables.escalations![0]!.owner_message_ids.length,2);
 await runEscalationTimeouts(h.db,()=>h.provider,new Date('2026-09-09T06:40:00Z'));assert.equal(h.sent.length,1);
 await runEscalationTimeouts(h.db,()=>h.provider,new Date('2026-09-09T07:30:00Z'));assert.equal(h.sent.length,2);assert.equal(h.tables.escalations![0]!.status,'closed_unanswered');assert.match(h.sent[1]!.text,/свяжется/);
});

function wav(){const bytes=Buffer.alloc(44+32000);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(32000,40);return bytes;}
test('voice runs full GOWS identity, quota, transcription, agent, FAQ pipeline and wipes buffer',async()=>{
 const {handleVoiceUsage}=await import('./voice-usage.service.js');
 const h=harness();h.tables.knowledge_items!.push({id:'faq',tenant_id:tenant,type:'faq',question:'Какая цена?',answer:'Цена 100',active:true});
 const body=JSON.parse(readFileSync('src/services/fixtures/gows-incoming-lid.json','utf8'));body.payload.from=customer;body.payload._data.Info.Chat=customer;body.payload.body=null;body.payload.hasMedia=true;body.payload.media={mimetype:'audio/wav',url:'http://internal/api/files/session/id.wav'};
 const bytes=wav();let calls=0;
 await handleVoiceUsage(h.db,{tenant:h.tables.tenants![0],instance:h.tables.whatsapp_instances![0]} as any,body,h.provider,{async transcribe(){calls++;return{text:'Какая цена?',confidence:0.99,ambiguous:false,language:'ru'};}},{async download(){return bytes;}});
 assert.equal(calls,1);assert.equal(h.admissions(),1);assert.equal(h.sent.at(-1)?.text,'Цена 100');assert.ok(bytes.every(b=>b===0));
 for(const type of ['message_received','message_sent','stt_call','voice_received']){const rows=h.tables.usage_events!.filter(r=>r.event_type===type);assert.ok(rows.length);assert.ok(rows.every(r=>typeof r.agent==='string'&&r.agent.length>0));}
 assert.equal(h.tables.messages![0]!.body,'Какая цена?');assert.equal(h.tables.messages![0]!.raw_payload.payload.media,null);
});
test('voice pause and quota stop STT; uncertainty asks for clarification without FAQ',async()=>{
 const {handleVoiceUsage}=await import('./voice-usage.service.js');
 for(const mode of ['paused','denied','uncertain','disabled']){
  const h=harness();if(mode==='paused')h.tables.conversations![0]!.bot_paused=true;if(mode==='denied')h.deny();let calls=0,downloads=0;
  const body=JSON.parse(readFileSync('src/services/fixtures/gows-incoming-lid.json','utf8'));body.payload.from=customer;body.payload._data.Info.Chat=customer;body.payload.body=null;body.payload.hasMedia=true;body.payload.media={mimetype:'audio/wav',url:'http://internal/api/files/session/id.wav'};
  await handleVoiceUsage(h.db,{tenant:h.tables.tenants![0],instance:h.tables.whatsapp_instances![0]} as any,body,h.provider,mode==='disabled'?null:{async transcribe(){calls++;return{text:'Неясно завтра',confidence:0.4,ambiguous:true,language:'ru'};}},{async download(){downloads++;return wav();}});
  assert.equal(calls,mode==='uncertain'?1:0);
  if(mode==='paused'){assert.equal(downloads,0);assert.equal(h.admissions(),0);assert.equal(h.sent.length,0);assert.equal(h.tables.usage_events![0]!.event_type,'message_observed');}
  else assert.match(h.sent.at(-1)!.text,mode==='uncertain'?/уточните/:mode==='denied'?/недоступны/:/не удалось распознать/);
 }
});
