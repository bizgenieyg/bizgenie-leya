import { BEHAVIOR_DEFAULTS } from '../config/behavior.js';
import { renderText } from './templates.service.js';
import type { OwnerSettings } from './owner-settings.service.js';
export interface NotificationSettings {mode:string;quiet_hours_start:string|null;quiet_hours_end:string|null;time_zone?:string;}
function minutes(time:string):number { const m=/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(time); return m ? Number(m[1])*60+Number(m[2]) : -1; }
function localMinutes(now:Date,timeZone:string):number {
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  return Number(parts.find(p=>p.type==='hour')?.value)*60+Number(parts.find(p=>p.type==='minute')?.value);
}
export function isWithinQuietHours(settings:NotificationSettings,now:Date):boolean {
  if(settings.mode!=='mute_all'||!settings.quiet_hours_start||!settings.quiet_hours_end) return false;
  const start=minutes(settings.quiet_hours_start),end=minutes(settings.quiet_hours_end),current=localMinutes(now,settings.time_zone??'UTC');
  if(start<0||end<0||start===end) return false;
  return start<end ? current>=start&&current<end : current>=start||current<end;
}
export function nextQuietHoursEnd(settings:NotificationSettings,now:Date):Date {
  const end=minutes(settings.quiet_hours_end??'');
  if(end<0) return now;
  const inside=isWithinQuietHours(settings,now);
  // Advance UTC instants to handle owner-local DST transitions, independent of VPS TZ.
  for(let t=Math.floor(now.getTime()/60000)*60000+60000;t<=now.getTime()+49*3600000;t+=60000){
    const candidate=new Date(t); if(inside?!isWithinQuietHours(settings,candidate):localMinutes(candidate,settings.time_zone??'UTC')===end) return candidate;
  }
  throw new Error('Quiet hours end unavailable');
}
export function buildEscalationText(clientName:string,clientMessage:string,settings?:OwnerSettings):string {
 return renderText(settings,'owner.escalation',String(settings?.behavior?.owner_language??BEHAVIOR_DEFAULTS.owner_language),{name:clientName,question:clientMessage});
}
/** Count real UTC elapsed time outside quiet intervals, including DST transitions. */
export function activeElapsedMs(settings:NotificationSettings,from:Date,to:Date):number {
 let elapsed=0;
 for(let t=from.getTime();t<to.getTime();){
  const end=Math.min(to.getTime(),Math.floor(t/60000)*60000+60000);
  if(!isWithinQuietHours(settings,new Date(t)))elapsed+=end-t;
  t=end;
 }
 return elapsed;
}
