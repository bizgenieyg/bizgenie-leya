import { localTime, validTimeZone } from "./time-zone.js";
import { renderText,languageOf } from '../services/templates.service.js';
import type { OwnerSettings } from '../services/owner-settings.service.js';
export const clientText = (text:string) => text.replace(/<[^>]*>/g, "").replace(/[<>]/g, "").trim();
export function withoutRepeatedIntroduction(text:string,introduced:boolean):string {
 if(!introduced)return clientText(text);
 return clientText(text).replace(/^(?:Я ассистент владельца\.|I'm the owner's assistant\.|אני העוזרת של בעל העסק\.)\s*/i,'').trim();
}
export function waitingText(question:string,quiet?:{at:Date;ownerZone:string;clientZone?:string|null},settings?:OwnerSettings):string {
 const language=languageOf(question);
 if(!quiet)return renderText(settings,'client.waiting',language);
 const zone=quiet.clientZone&&validTimeZone(quiet.clientZone)?quiet.clientZone:quiet.ownerZone;
 return renderText(settings,quiet.clientZone&&validTimeZone(quiet.clientZone)?'client.waiting_quiet_client':'client.waiting_quiet',language,{time:localTime(quiet.at,zone,language),zone});
}
export function ownerAnswerText(question:string,answer:string,settings?:OwnerSettings):string {
 return renderText(settings,'client.owner_answer',languageOf(question),{answer:clientText(answer)});
}
export function isDeferredAnswer(text:string):boolean {
  if (/(?:отвечу|скажу|уточню|напишу|проверю).{0,20}(?:позже|потом|завтра|утром)|(?:позже|потом|завтра|утром).{0,20}(?:отвечу|скажу|уточню|напишу|проверю)|^занят[а]?(?: сейчас)?[.!\s]*$/i.test(text.trim())) return true;
  return /^(?:(?:отвечу|скажу|уточню|напишу|проверю)\s+)?(?:позже|потом|завтра|утром)(?:\s+(?:отвечу|скажу|напишу|проверю|уточню))?[.!\s]*$|^(?:занят[а]?|спокойной ночи|сейчас не могу|отвечу позже|later|tomorrow|i(?:'ll| will) (?:reply|answer) later|אענה אחר כך|מחר|אחר כך)[.!\s]*$/i.test(text.trim());
}
// Normalize only a known serialized message-ID structure; never infer a chat identity.
export function replyId(id:string):string { return /^(?:true|false)_[^_]+_(.+)$/.exec(id)?.[1] ?? id; }
