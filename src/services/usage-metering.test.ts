import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { DatabaseClient } from '../db/supabase.js';
import { recordUsageEvent,admitUsage } from './usage.service.js';
import { meterAI,meterWhatsApp } from './metered-providers.js';
import { voiceUsage } from './voice-usage.service.js';
import { limitClientText } from './usage-notifications.service.js';
process.env.SUPABASE_URL='https://database.invalid';process.env.SUPABASE_SERVICE_ROLE_KEY='test-only';
test('metering never breaks message handling on database rejection or thrown network errors',async()=>{
  for(const db of [{from(){throw new Error('private secret');}},{from(){return{insert:async()=>({error:{code:'network'}})};}}] as unknown as DatabaseClient[]){
    await recordUsageEvent(db,{tenantId:'t',eventType:'message_received'});
    const provider=meterWhatsApp(db,'t',{async getSessionStatus(){return{status:'WORKING'};},async sendMessage(){return{id:'sent'};}});
    assert.equal((await provider.sendMessage({session:'s',chatId:'12345678@lid',text:'private'})).id,'sent');
    assert.equal((await admitUsage(db,'t','id')).allowed,true);
  }
});
test('fail-open admission writes a structured operator-visible system event',async()=>{
  const rows:any[]=[];
  const db={rpc:async()=>({data:null,error:{code:'network'}}),from(table:string){return{insert:async(value:unknown)=>{rows.push({table,value});return{error:null};}};}} as unknown as DatabaseClient;
  assert.equal((await admitUsage(db,'tenant','message')).unavailable,true);
  assert.deepEqual(rows,[{table:'system_logs',value:{tenant_id:'tenant',level:'error',event:'usage_admission_unavailable',details:{mode:'fail_open'}}}]);
});
test('Gemini success, failure and owner translation are metered, disabled provider is not',async()=>{
  const events:any[]=[];const db={from(){return{insert:async(value:unknown)=>{events.push(value);return{error:null};}};}} as unknown as DatabaseClient;
  let calls=0;const raw={async generateReply(){calls++;return{text:'ok',usage:{model:'model',input_tokens:12,output_tokens:3}};}};
  const model=meterAI(db,'tenant',raw)!;await model.generateReply({systemPrompt:'private',userMessage:'private'});
  assert.equal(events[0].event_type,'model_call');assert.equal(events[0].metadata.input_tokens,12);
  assert.equal(meterAI(db,'tenant',model),model);assert.equal(meterAI(db,'tenant',null),null);assert.equal(calls,1);
  await assert.rejects(meterAI(db,'tenant',{async generateReply(){throw new Error('private error');}})!.generateReply({systemPrompt:'private',userMessage:'private'}));
  assert.equal(events[1].metadata.status,'failed');assert.doesNotMatch(JSON.stringify(events),/private/);
});
test('voice seconds are read without admitting groups, outgoing or unknown duration as zero-known',()=>{
  const body=JSON.parse(readFileSync('src/services/fixtures/gows-incoming-lid.json','utf8'));
  body.payload.media={mimetype:'audio/ogg',url:'http://localhost/api/files/session/voice.ogg'};body.payload.body=null;body.payload.hasMedia=true;body.payload._data.Message={audioMessage:{seconds:23,ptt:true}};
  assert.equal(voiceUsage(body)?.seconds,23);
  body.payload._data.Message.audioMessage.seconds=null;assert.equal(voiceUsage(body)?.seconds,null);
  body.payload.fromMe=true;assert.equal(voiceUsage(body),null);
  body.payload.fromMe=false;body.payload.from='123456789@g.us';assert.equal(voiceUsage(body),null);
  assert.match(limitClientText('Вопрос'),/Владелец/);assert.doesNotMatch(limitClientText('Вопрос'),/[<>]/);
});
