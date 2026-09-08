import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiSTT } from '../providers/stt/gemini.js';
process.env.WAHA_URL='https://waha.invalid';process.env.WAHA_API_KEY='test-secret';
test('STT sends original audio, validates structured uncertainty, and rejects incomplete output',async()=>{
 const original=globalThis.fetch;let calls=0;
 try{
  globalThis.fetch=async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));assert.equal(body.contents[0].parts[1].inlineData.mimeType,'audio/ogg');assert.equal(body.contents[0].parts[1].inlineData.data,Buffer.from('sample').toString('base64'));assert.ok(init?.signal);return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({text:'שלום',confidence:0.8,ambiguous:true,language:'he'})}]}}],usageMetadata:{promptTokenCount:32,candidatesTokenCount:8,totalTokenCount:40}});};
  const result=await new GeminiSTT('test').transcribe(Buffer.from('sample'),'audio/ogg',10);assert.equal(result.ambiguous,true);assert.equal(result.usage?.total_tokens,40);assert.equal(calls,1);
  globalThis.fetch=async()=>Response.json({candidates:[{finishReason:'MAX_TOKENS'}]});await assert.rejects(new GeminiSTT('test').transcribe(Buffer.from('x'),'audio/ogg',10),/incomplete/);
 }finally{globalThis.fetch=original;}
});
test('media downloader uses trusted WAHA host/session and prevents redirects and oversized buffers',async()=>{
 const {WahaMedia}=await import('../providers/media/waha-media.js');const provider=new WahaMedia(),original=globalThis.fetch;let calls=0;
 try{
  globalThis.fetch=async(url,init)=>{calls++;assert.equal(new URL(String(url)).host,'waha.invalid');assert.equal(init?.redirect,'error');return new Response(Buffer.from('abc'));};
  assert.equal((await provider.download('http://localhost:3000/api/files/tenant/x.ogg','tenant',100,10)).toString(),'abc');
  await assert.rejects(provider.download('https://attacker.invalid/api/files/other/tenant/x','tenant',100,10));assert.equal(calls,1);
  await assert.rejects(provider.download('http://localhost/api/files/tenant/x.ogg','tenant',2,10),/large/);
 }finally{globalThis.fetch=original;}
});
