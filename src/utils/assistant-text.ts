import { localTime, validTimeZone } from "./time-zone.js";
import { renderText,languageOf } from '../services/templates.service.js';
import type { OwnerSettings } from '../services/owner-settings.service.js';
const INTERNAL_AGENT_CODE=/\b(?:SALE|SUPPORT|RECEPTION|CORE)\b/g;
export const containsInternalAgentCode=(text:string)=>/\b(?:SALE|SUPPORT|RECEPTION|CORE)\b/.test(text);
/** Z11: a message to the owner — markup and internal codes out, but «Да / Нет» keeps its slash. */
export const ownerText = (text:string) => text.replace(/<[^>]*>/g, "").replace(/[<>]/g, "").replace(INTERNAL_AGENT_CODE,'').trim();
export const clientText = (text:string) => text.replace(/<[^>]*>/g, "").replace(/[<>]/g, "").replace(INTERNAL_AGENT_CODE,'').replace(/\s+\/\s+/g,' ').replace(/\s*\/\s*(?=[?!.,]|$)/g,'').replace(/[ \t]+([?!.,])/g,'$1').replace(/[ \t]{2,}/g,' ').replace(/[ \t]*\n[ \t]*/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
/** Z17: a greeting at the start of a reply («Здравствуйте 🌷», «Привет, Диана!», «שלום!», «Hi!»), with the name after it. */
const GREETING=/^(?:[Зз]дравствуйте|[Пп]ривет|[Дд]обрый (?:день|вечер)|[Дд]оброе утро|שלום|היי|[Hh]i|[Hh]ello)(?![\p{L}])(?:,?[ \t]+\p{Lu}[\p{L}'’-]*(?=[^\p{L}]|$))?[^\p{L}\p{N}\n]*/u;
/** Z17: «Я Лея, ИИ-ассистент Ноготки.» / «אני ליה, העוזרת של …» / «I'm Leya, … assistant» — one sentence. */
const SELF_INTRODUCTION=/^(?:я|i'm|i am|אני)[ \t][^.!?\n]{0,120}?(?:ассистент|assistant|עוזר)[^.!?\n]{0,80}[.!]?[ \t]*\n?/iu;
/**
 * A later reply in the conversation: the greeting and self-introduction at its start are dropped (Z17: the core greets
 * only in the first message, but the model repeats the example). Nothing else left — the reply stays as it was.
 */
export function withoutRepeatedIntroduction(text:string,introduced:boolean):string {
 const clean=clientText(text);
 if(!introduced)return clean;
 const legacy=clean.replace(/^(?:Я ассистент владельца\.|I'm the owner's assistant\.|אני העוזרת של בעל העסק\.)\s*/i,'').trim();
 if(legacy!==clean)return legacy;
 const greeting=GREETING.exec(clean)?.[0]??'';
 const rest=clean.slice(greeting.length);
 const intro=SELF_INTRODUCTION.exec(rest)?.[0]??'';
 // A greeting alone stays when nothing follows it that is not the introduction (the client only said hello again).
 const stripped=rest.slice(intro.length).trim();
 if(!stripped||(!greeting&&!intro))return clean;
 return stripped.charAt(0).toLocaleUpperCase()+stripped.slice(1);
}
export function waitingText(question:string,quiet?:{at:Date|null;ownerZone:string;clientZone?:string|null},settings?:OwnerSettings,replyLanguage?:string):string {
 const language=replyLanguage??languageOf(question);
 if(!quiet)return renderText(settings,'client.waiting',language);
 // Quiet, but the schedule never reopens: promise a callback, don't name a date.
 if(!quiet.at)return renderText(settings,'client.waiting_no_schedule',language);
 const zone=quiet.clientZone&&validTimeZone(quiet.clientZone)?quiet.clientZone:quiet.ownerZone;
 return renderText(settings,quiet.clientZone&&validTimeZone(quiet.clientZone)?'client.waiting_quiet_client':'client.waiting_quiet',language,{time:localTime(quiet.at,zone,language),zone});
}
export function ownerAnswerText(question:string,answer:string,settings?:OwnerSettings,replyLanguage?:string):string {
 return renderText(settings,'client.owner_answer',replyLanguage??languageOf(question),{answer:clientText(answer)});
}
/**
 * Z14 review: only a whole message that is a word to the assistant and nothing for the client — «позже», «уточню
 * завтра», «не сейчас». A time alone («завтра», «утром») or a plan («напишу ему завтра», «завтра на встрече обсудим»)
 * may be the answer itself: the classifier decides, and when unsure it is an answer.
 */
export function isDeferredAnswer(text:string):boolean {
  return /^(?:(?:отвечу|уточню|проверю)\s+)?(?:позже|потом)(?:\s+(?:отвечу|уточню|проверю))?[.!\s]*$|^(?:отвечу|уточню|проверю)\s+(?:завтра|утром)[.!\s]*$|^(?:завтра|утром)\s+(?:отвечу|уточню|проверю)[.!\s]*$|^(?:занят[а]?(?: сейчас)?|сейчас не могу|не сейчас|later|i(?:'ll| will) (?:reply|answer) later|אענה אחר כך|אחר כך)[.!\s]*$/i.test(text.trim());
}
// Normalize only a known serialized message-ID structure; never infer a chat identity.
// Z14: a group message id ends with its sender (true_<group>@g.us_<id>_<sender>@c.us) while a quote carries the bare id.
export function replyId(id:string):string { return /^(?:true|false)_[^_]+_([^_]+)_\d+(?::\d+)?@(?:c\.us|s\.whatsapp\.net|lid)$/.exec(id)?.[1] ?? /^(?:true|false)_[^_]+_(.+)$/.exec(id)?.[1] ?? id; }
