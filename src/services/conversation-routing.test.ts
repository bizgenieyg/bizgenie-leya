import test from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseClient } from '../db/supabase.js';
import type { OwnerSettings } from './owner-settings.service.js';
import { entrySource,routeConversation } from './conversation-routing.service.js';

const tenant='123e4567-e89b-42d3-a456-426614174000';
const base:OwnerSettings={owner_phone:null,owner_chat_id:null,mode:'mute_all',quiet_hours_start:null,quiet_hours_end:null,auto_replies_paused:false};
function db(open=false){const writes:{table:string;value:any}[]=[];return {writes,client:{from(table:string){const q:any={select(){return q;},eq(){return q;},in(){return q;},limit(){return q;},update(value:any){writes.push({table,value});return q;},insert(value:any){writes.push({table,value});return q;},then(resolve:any){return Promise.resolve({data:table==='escalations'&&open?[{id:'e'}]:[],error:null}).then(resolve);}};return q;}} as unknown as DatabaseClient};}
const conversation=(extra:Record<string,unknown>={})=>({id:'c',tenant_id:tenant,client_id:'x',status:'active',last_message_at:new Date().toISOString(),source_label:null,routed_agent:null,route_selected_at:null,reception_question_asked:false,...extra});

test('entry source is parsed and deterministic campaign/source/open-case routes win',async()=>{
 assert.equal(entrySource('go https://x.test/?utm_campaign=summer'),'summer');
 let h=db();let result=await routeConversation(h.client,tenant,conversation(),'AUDIT now',{...base,behavior:{campaign_routes:[{keyword:'AUDIT',agent:'SALE'}]}},null,undefined,true);assert.equal(result.kind==='agent'&&result.method,'campaign');
 h=db();result=await routeConversation(h.client,tenant,conversation(),'https://x.test/?source=catalog',{...base,behavior:{source_routes:[{source:'catalog',agent:'SALE'}]}},null,undefined,true);assert.equal(result.kind==='agent'&&result.method,'source');assert.ok(h.writes.some(x=>x.value.source_label==='catalog'));
 h=db(true);result=await routeConversation(h.client,tenant,conversation(),'hello',base,null);assert.equal(result.kind==='agent'&&result.agent.name,'SUPPORT');
});

test('route is sticky, another-agent signal switches, and inactivity reclassifies',async()=>{
 let h=db();let result=await routeConversation(h.client,tenant,conversation({routed_agent:'SUPPORT'}),'hello',base,null);assert.equal(result.kind==='agent'&&result.method,'sticky');
 h=db();result=await routeConversation(h.client,tenant,conversation({routed_agent:'SUPPORT'}),'Какая цена?',base,null);assert.equal(result.kind==='agent'&&result.agent.name,'SALE');
 h=db();result=await routeConversation(h.client,tenant,conversation({routed_agent:'SUPPORT',last_message_at:'2020-01-01T00:00:00Z'}),'hello',base,{async generateReply(){return{text:'{"agent":"SALE","confidence":0.9}'}}});assert.equal(result.kind==='agent'&&result.agent.name,'SALE');
});

test('low confidence asks once through RECEPTION, persists unknown, then escalates',async()=>{
 const ai={async generateReply(){return{text:'{"agent":"SALE","confidence":0.3}'}}};let h=db();let result=await routeConversation(h.client,tenant,conversation(),'неясно',base,ai);assert.equal(result.kind,'reception');assert.ok(h.writes.some(x=>x.table==='unrecognized_routes'));
 h=db();result=await routeConversation(h.client,tenant,conversation({routed_agent:'RECEPTION',reception_question_asked:true}),'всё ещё неясно',base,ai);assert.equal(result.kind,'escalate');
});
