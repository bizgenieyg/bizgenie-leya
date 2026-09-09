import { BEHAVIOR_DEFAULTS } from '../config/behavior.js';
import { DEFAULT_TIME_ZONE,intlTimeZone } from '../config/time-zones.js';
import { MAX_SCHEDULE_LOOKAHEAD_MINUTES } from '../config/behavior.js';
import { renderText } from './templates.service.js';
import type { OwnerSettings } from './owner-settings.service.js';
export interface NotificationSettings {mode:string;quiet_hours_start:string|null;quiet_hours_end:string|null;time_zone?:string;}
type RuntimeSettings=NotificationSettings&{behavior?:Record<string,unknown>;exceptions?:Array<{start_date:string;end_date:string;kind:string;work_start:string|null;work_end:string|null;recurs_annually:boolean}>};
function minutes(time:string):number { const m=/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(time); return m ? Number(m[1])*60+Number(m[2]) : -1; }
function localMinutes(now:Date,timeZone:string):number {
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:intlTimeZone(timeZone),hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  return Number(parts.find(p=>p.type==='hour')?.value)*60+Number(parts.find(p=>p.type==='minute')?.value);
}
function localDate(now:Date,timeZone:string){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:intlTimeZone(timeZone),year:'numeric',month:'2-digit',day:'2-digit',weekday:'short'}).formatToParts(now).map(p=>[p.type,p.value]));
  const weekdays:Record<string,string>={Sun:'0',Mon:'1',Tue:'2',Wed:'3',Thu:'4',Fri:'5',Sat:'6'};
  return {iso:`${parts.year}-${parts.month}-${parts.day}`,monthDay:`${parts.month}-${parts.day}`,weekday:weekdays[parts.weekday!]!};
}
function inDateRange(date:string,start:string,end:string,annual:boolean){
  const value=annual?date.slice(5):date,a=annual?start.slice(5):start,b=annual?end.slice(5):end;
  return a<=b?value>=a&&value<=b:value>=a||value<=b;
}
function outsideWorkingHours(current:number,start:string,end:string){
  const a=minutes(start),b=minutes(end);if(a<0||b<0||a===b)return true;
  return a<b?current<a||current>=b:current<b&&current>=a;
}
export function isWithinQuietHours(settings:RuntimeSettings,now:Date):boolean {
  const zone=settings.time_zone??DEFAULT_TIME_ZONE,current=localMinutes(now,zone),date=localDate(now,zone);
  const exception=settings.exceptions?.find(e=>inDateRange(date.iso,e.start_date,e.end_date,e.recurs_annually));
  if(exception)return exception.kind==='day_off'||outsideWorkingHours(current,exception.work_start??'',exception.work_end??'');
  const weekly=settings.behavior?.weekly_schedule as Record<string,{mode:string;start?:string;end?:string}>|undefined;
  const day=weekly?.[date.weekday];
  if(day)return day.mode==='day_off'||(day.mode==='working_hours'&&outsideWorkingHours(current,day.start??'',day.end??''));
  if(settings.mode!=='mute_all'||!settings.quiet_hours_start||!settings.quiet_hours_end) return false;
  const start=minutes(settings.quiet_hours_start),end=minutes(settings.quiet_hours_end),legacyCurrent=localMinutes(now,zone);
  if(start<0||end<0||start===end) return false;
  return start<end ? legacyCurrent>=start&&legacyCurrent<end : legacyCurrent>=start||legacyCurrent<end;
}
export function nextQuietHoursEnd(settings:RuntimeSettings,now:Date):Date {
  const inside=isWithinQuietHours(settings,now);
  // Advance UTC instants to handle owner-local DST transitions, independent of VPS TZ.
  for(let minute=1;minute<=MAX_SCHEDULE_LOOKAHEAD_MINUTES;minute++){
    const candidate=new Date(Math.floor(now.getTime()/60000)*60000+minute*60000);
    if(inside?!isWithinQuietHours(settings,candidate):isWithinQuietHours(settings,candidate)) return candidate;
  }
  throw new Error('Quiet hours end unavailable');
}
export function buildEscalationText(clientName:string,clientMessage:string,settings?:OwnerSettings):string {
 return renderText(settings,'owner.escalation',String(settings?.behavior?.owner_language??BEHAVIOR_DEFAULTS.owner_language),{name:clientName,question:clientMessage});
}
/** Count real UTC elapsed time outside quiet intervals, including DST transitions. */
export function activeElapsedMs(settings:RuntimeSettings,from:Date,to:Date):number {
 let elapsed=0;
 for(let t=from.getTime();t<to.getTime();){
  const end=Math.min(to.getTime(),Math.floor(t/60000)*60000+60000);
  if(!isWithinQuietHours(settings,new Date(t)))elapsed+=end-t;
  t=end;
 }
 return elapsed;
}
