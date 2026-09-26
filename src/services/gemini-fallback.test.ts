import assert from "node:assert/strict";
import test from "node:test";
import { GeminiProvider, DEFAULT_GEMINI_MODEL } from "../providers/ai/gemini.provider.js";
import { createAIProvider } from "../providers/ai/index.js";
import { generateKnowledgeReply,generateKnowledgeReplyResult,generateReceptionReply } from "./ai-fallback.service.js";
import { replyLanguage } from './templates.service.js';

const context = { business:{owner_name:"Даниэль",business_name:"BizGenie",language:"ru"}, assistant: { assistant_name: "Лея", allowed_languages: ["he", "ru", "en"], tone: "friendly", mode: null, system_rules: null, style_profile_md: "Пиши тепло и по делу." }, knowledge: [{ id: "a", question: "Часы?", answer: "9–18" }] };

test("absent key is a model outage: no API call, failure 'missing_api_key', never missing knowledge", async () => {
  const originalFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => { fetched++; throw new Error("no network"); }) as typeof fetch;
  try {
    const provider = createAIProvider("");
    assert.ok(!(provider instanceof GeminiProvider));
    const viaProvider = await generateKnowledgeReplyResult(context, "Когда?", provider);
    assert.deepEqual(viaProvider, { reply: null, missingKnowledge: false, unanswered: [], failure: "missing_api_key" });
    const empty = await generateKnowledgeReplyResult({ ...context, knowledge: [] }, "Когда?", provider);
    assert.equal(empty.missingKnowledge, false, "an empty base without a key is still an outage");
    assert.equal(empty.failure, "missing_api_key");
    assert.deepEqual(await generateKnowledgeReplyResult(context, "Когда?", null), { reply: null, missingKnowledge: false, unanswered: [], failure: "missing_api_key" });
    const reception = await generateReceptionReply(context, "Привет", "Уточните", provider, [], false);
    assert.equal(reception.failure, "missing_api_key");
    assert.equal(fetched, 0);
  } finally { globalThis.fetch = originalFetch; }
});
test('sector appears in knowledge and reception prompts only when set',async()=>{
 const prompts:string[]=[];
 const ai={async generateReply(input:{systemPrompt:string;userMessage:string}){prompts.push(input.systemPrompt);return{text:'Ответ'};}};
 const withSector={...context,business:{...context.business,business_sector:'косметолог'}};
 await generateKnowledgeReply(withSector,'Когда?',ai);
 await generateReceptionReply(withSector,'Привет','Уточните вопрос',ai,[],false);
 await generateKnowledgeReply(context,'Когда?',ai);
 assert.match(prompts[0]!,/Сфера бизнеса владельца: "косметолог"/);
 assert.match(prompts[1]!,/Сфера бизнеса владельца: "косметолог"/);
 assert.doesNotMatch(prompts[2]!,/Сфера бизнеса владельца:/);
});
test("explicit no-knowledge marker is distinguishable from provider failure",async()=>{
 const missing=await generateKnowledgeReplyResult(context,'Гарантия?',{async generateReply(){return{text:'NO_KNOWLEDGE_ANSWER'}}});
 assert.deepEqual(missing,{reply:null,missingKnowledge:true,unanswered:[]});
 const warn=console.warn;console.warn=()=>undefined;try{const failure=await generateKnowledgeReplyResult(context,'Гарантия?',{async generateReply(){throw new Error('offline')}});assert.deepEqual(failure,{reply:null,missingKnowledge:false,unanswered:[],failure:'unavailable'});}finally{console.warn=warn;}
});
test("Gemini receives tenant knowledge/settings and hard rules, returns only final text", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`);
    assert.equal((init?.headers as Record<string, string>)["x-goog-api-key"], "test-key");
    assert.equal(String(url).includes("test-key"), false);
    assert.ok(init?.signal);
    const body = JSON.parse(String(init?.body));
    assert.match(body.systemInstruction.parts[0].text, /ТОЛЬКО на основе/);
    assert.match(body.systemInstruction.parts[0].text, /Никогда не выдумывай/);
    assert.match(body.systemInstruction.parts[0].text, /businessIdentity/);
    const input = JSON.parse(body.contents[0].parts[0].text);
    assert.deepEqual(input.businessIdentity,{owner_name:"Даниэль",business_name:"BizGenie",language:"ru"});
    assert.deepEqual(input.knowledge, [{ question: "Часы?", answer: "9–18" }]);
    assert.deepEqual(input.assistant.languages, ["he", "ru", "en"]);
    assert.equal(input.assistant.style, "Пиши тепло и по делу.");
    assert.equal(input.customerMessage, "Когда?");
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ thought: true, text: "private thinking" }, { text: "С 9 до 18." }] } }] });
  };
  try { assert.equal(await generateKnowledgeReply(context, "Когда?", new GeminiProvider("test-key")), "С 9 до 18."); }
  finally { globalThis.fetch = originalFetch; }
});
test('dialogue memory is passed in order and repeated greeting is forbidden',async()=>{
 let prompt='',payload:any;
 const ai={async generateReply(input:{systemPrompt:string;userMessage:string}){prompt=input.systemPrompt;payload=JSON.parse(input.userMessage);return{text:'Продолжаем разговор.'};}};
 const memory=[{fromMe:false,text:'Первый вопрос',createdAt:'2026-09-09T10:00:00Z'},{fromMe:true,text:'Первый ответ',createdAt:'2026-09-09T10:01:00Z'}];
 assert.equal(await generateKnowledgeReply(context,'Уточнение',ai,'',memory,true),'Продолжаем разговор.');
 assert.deepEqual(payload.conversationHistory,[{role:'customer',text:'Первый вопрос'},{role:'assistant',text:'Первый ответ'}]);
 assert.match(prompt,/не приветствуй клиента и не представляйся снова/);
});
test('reception chats naturally without exposing internal agent codes or asking for a department',async()=>{
 let prompt='',payload:any;const ai={async generateReply(input:{systemPrompt:string;userMessage:string}){prompt=input.systemPrompt;payload=JSON.parse(input.userMessage);return{text:'Рад помочь. Чем вы сегодня заняты?'};}};
 const clarification='Я ассистент владельца. Расскажите, пожалуйста, что вам нужно — постараюсь помочь.';
 const chat=await generateReceptionReply(context,'Просто привет',clarification,ai,[],true);
 assert.equal(chat.reply,'Рад помочь. Чем вы сегодня заняты?');assert.equal(chat.escalate,false);assert.match(prompt,/не приветствуй и не представляйся снова/);assert.match(prompt,/не повторяй один вопрос в каждой реплике/i);
 assert.match(prompt,/не проси клиента выбирать отдел/i);assert.doesNotMatch(prompt,/\b(?:SALE|SUPPORT|RECEPTION|CORE)\b/);
 assert.match(prompt,/Пиши тепло и по делу/);assert.match(prompt,/businessIdentity/);
 assert.deepEqual(payload.businessIdentity,{owner_name:'Даниэль',business_name:'BizGenie',language:'ru'});
 const leaked=await generateReceptionReply(context,'Привет',clarification,{async generateReply(){return{text:'Выберите SUPPORT / SALE?'};}},[],false);
 assert.equal(leaked.reply,clarification);assert.doesNotMatch(leaked.reply!,/\b(?:SALE|SUPPORT|RECEPTION|CORE)\b/);
 const escalate=await generateReceptionReply(context,'Позовите владельца','уточнение',{async generateReply(){return{text:'ESCALATE_OWNER'};}},[],false);assert.equal(escalate.escalate,true);
});
test('the detected language is an explicit model constraint for every turn',async()=>{
 const prompts:string[]=[];const ai={async generateReply(input:{systemPrompt:string}){prompts.push(input.systemPrompt);return{text:'ok'};}};
 await generateKnowledgeReply(context,'שלום',ai,'',[],false,'he');
 await generateKnowledgeReply(context,'Привет',ai,'',[],true,'ru');
 await generateKnowledgeReply(context,'Hello',ai,'',[],true,'en');
 await generateReceptionReply(context,'שלום','אפשר לעזור?',ai,[],false,'he');
 assert.match(prompts[0]!,/Язык этого ответа: he/);
 assert.match(prompts[1]!,/Язык этого ответа: ru/);
 assert.match(prompts[2]!,/Язык этого ответа: en/);
 assert.match(prompts[3]!,/Язык этого ответа: he/);
});
test('reply language follows every incoming turn unless the owner overrode it',()=>{
 assert.equal(replyLanguage('שואלת עבור חברה'),'he');
 assert.equal(replyLanguage('Нужна консультация'),'ru');
 assert.equal(replyLanguage('I need help'),'en');
 assert.equal(replyLanguage('Снова по-русски',{language:'he',language_overridden:false}),'ru');
 assert.equal(replyLanguage('Теперь на русском',{language:'he',language_overridden:true}),'he');
});
test("HTTP failures, blocked/empty/partial output and timeout retain old fallback behavior", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const timeout = AbortSignal.timeout;
  const warnings: unknown[] = [];
  console.warn = (...args) => { warnings.push(args); };
  try {
    for (const response of [new Response("private secret", { status: 503 }), Response.json({}), Response.json({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "unfinished" }] } }] })]) {
      globalThis.fetch = async () => response;
      assert.equal(await generateKnowledgeReply(context, "private text", new GeminiProvider("test-key")), null);
    }
    AbortSignal.timeout = (ms: number) => { assert.equal(ms, 10000); return AbortSignal.abort(); };
    globalThis.fetch = async (_url, init) => { init?.signal?.throwIfAborted(); throw new Error("expected aborted signal"); };
    assert.equal(await generateKnowledgeReply(context, "private text", new GeminiProvider("test-key")), null);
    assert.doesNotMatch(JSON.stringify(warnings), /private|secret|test-key/);
  } finally { globalThis.fetch = originalFetch; console.warn = originalWarn; AbortSignal.timeout = timeout; }
});
