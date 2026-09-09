import { intlTimeZone,supportedTimeZone } from '../config/time-zones.js';
export function validTimeZone(value:string):boolean {
  if(supportedTimeZone(value))return true;
  if(!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;
  try { new Intl.DateTimeFormat('en',{timeZone:value}).format();return true; }catch{return false;}
}
export function localTime(date:Date,timeZone:string,language='ru'):string {
  return new Intl.DateTimeFormat(language,{timeZone:intlTimeZone(timeZone),day:'numeric',month:'long',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date);
}
export function clientTimeZoneCommand(text:string):string|null {
  const value=/^(?:часовой пояс|time ?zone|אזור זמן)\s+([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*|UTC(?:[+-]\d{1,2})?)$/i.exec(text.trim())?.[1];
  return value&&validTimeZone(value)?value:null;
}
