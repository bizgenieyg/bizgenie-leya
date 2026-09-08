import { localTime, validTimeZone } from "./time-zone.js";
export const clientText = (text:string) => text.replace(/<[^>]*>/g, "").replace(/[<>]/g, "").trim();
export function waitingText(question:string,quiet?:{at:Date;ownerZone:string;clientZone?:string|null}):string {
  const language=/[א-ת]/.test(question)?'he':/[а-яё]/i.test(question)?'ru':'en';
  if(!quiet) return language==='he'?'אני העוזרת של בעל העסק. אברר עם בעל העסק ואעדכן כשאקבל תשובה.':language==='en'?"I'm the owner's assistant. I'll check with the owner and get back to you when I have an answer.":'Я ассистент владельца. Уточню у владельца и напишу, когда получу ответ.';
  const clientZone=quiet.clientZone&&validTimeZone(quiet.clientZone)?quiet.clientZone:null;
  const zone=clientZone??quiet.ownerZone;
  const time=localTime(quiet.at,zone,language);
  if(language==='he') return `אני העוזרת של בעל העסק. אברר אחרי שעות השקט, החל מ־${time} (${zone}${clientZone?', הזמן המקומי שלך':''}), ואעדכן כשאקבל תשובה.`;
  if(language==='en') return `I'm the owner's assistant. I'll check after quiet hours, from ${time} (${zone}${clientZone?', your local time':", the owner's time"}), and get back to you when I have an answer.`;
  return `Я ассистент владельца. Уточню после тихих часов, с ${time} (${zone}${clientZone?', ваше местное время':', время владельца'}), и напишу, когда получу ответ.`;
}
export function ownerAnswerText(question:string,answer:string):string {
  const prefix = /[א-ת]/.test(question) ? 'אני העוזרת של בעל העסק. זו התשובה שקיבלתי מבעל העסק:' : /[а-яё]/i.test(question) ? 'Я ассистент владельца. Передаю ответ владельца:' : "I'm the owner's assistant. Here is the owner's answer:";
  return `${prefix}\n\n«${clientText(answer)}»`;
}
export function isDeferredAnswer(text:string):boolean {
  if (/(?:отвечу|скажу|уточню|напишу|проверю).{0,20}(?:позже|потом|завтра|утром)|(?:позже|потом|завтра|утром).{0,20}(?:отвечу|скажу|уточню|напишу|проверю)|^занят[а]?(?: сейчас)?[.!\s]*$/i.test(text.trim())) return true;
  return /^(?:(?:отвечу|скажу|уточню|напишу|проверю)\s+)?(?:позже|потом|завтра|утром)(?:\s+(?:отвечу|скажу|напишу|проверю|уточню))?[.!\s]*$|^(?:занят[а]?|спокойной ночи|сейчас не могу|отвечу позже|later|tomorrow|i(?:'ll| will) (?:reply|answer) later|אענה אחר כך|מחר|אחר כך)[.!\s]*$/i.test(text.trim());
}
// Normalize only a known serialized message-ID structure; never infer a chat identity.
export function replyId(id:string):string { return /^(?:true|false)_[^_]+_(.+)$/.exec(id)?.[1] ?? id; }
