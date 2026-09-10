import { BEHAVIOR_DEFAULTS } from '../config/behavior.js';
import { DEFAULT_TIME_ZONE } from '../config/time-zones.js';
import { zonedDateTimeFormat } from '../utils/time-zone.js';
import { renderText } from './templates.service.js';
import type { OwnerSettings } from './owner-settings.service.js';
export interface NotificationSettings {mode:string;quiet_hours_start:string|null;quiet_hours_end:string|null;time_zone?:string;}
type RuntimeSettings=NotificationSettings&{behavior?:Record<string,unknown>;exceptions?:Array<{start_date:string;end_date:string;kind:string;work_start:string|null;work_end:string|null;recurs_annually:boolean}>};
function minutes(time:string):number { const m=/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(time); return m ? Number(m[1])*60+Number(m[2]) : -1; }
function localMinutes(now:Date,timeZone:string):number {
  const parts=zonedDateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit',hourCycle:'h23'},timeZone).formatToParts(now);
  return Number(parts.find(p=>p.type==='hour')?.value)*60+Number(parts.find(p=>p.type==='minute')?.value);
}
function localDate(now:Date,timeZone:string){
  const parts=Object.fromEntries(zonedDateTimeFormat('en-CA',{year:'numeric',month:'2-digit',day:'2-digit',weekday:'short'},timeZone).formatToParts(now).map(p=>[p.type,p.value]));
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
// Wall-clock time in `timeZone` -> the UTC instant, resolving DST with a second pass.
function tzOffsetMs(timeZone:string,at:Date):number {
  const p=Object.fromEntries(zonedDateTimeFormat('en-US',{hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'},timeZone).formatToParts(at).map(x=>[x.type,x.value]));
  return Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),Number(p.hour),Number(p.minute),Number(p.second))-Math.floor(at.getTime()/1000)*1000;
}
function wallToInstant(y:number,mo:number,d:number,minsOfDay:number,timeZone:string):number {
  const guess=Date.UTC(y,mo-1,d,Math.floor(minsOfDay/60),minsOfDay%60);
  return guess-tzOffsetMs(timeZone,new Date(guess-tzOffsetMs(timeZone,new Date(guess))));
}
/**
 * Next UTC instant quiet hours end (or start, if `now` is outside quiet hours), or `null`
 * when the schedule has no working window at all (e.g. every weekday set to day_off).
 * Callers must not invent a wait date then — they tell the client the owner will get back
 * to them and escalate immediately.
 *
 * Evaluated only at the instants where the schedule can change state — local midnight, an
 * hourly grid (DST / edge backstop), and each day's working-hours and exception bounds —
 * so it stays off the message hot path instead of spinning a minute-by-minute loop.
 */
export function nextQuietHoursEnd(settings:RuntimeSettings,now:Date):Date|null {
  const inside=isWithinQuietHours(settings,now);
  const zone=settings.time_zone??DEFAULT_TIME_ZONE;
  const base=Math.floor(now.getTime()/60000)*60000;
  const weekly=settings.behavior?.weekly_schedule as Record<string,{mode:string;start?:string;end?:string}>|undefined;
  // A weekly schedule repeats every 7 days; a legacy daily window resets every day.
  const horizonDays=weekly?8:2;
  const [Y,M,D]=localDate(now,zone).iso.split('-').map(Number) as [number,number,number];
  const marks=new Set<number>();
  for(let d=0;d<=horizonDays;d++){
    const wall=new Date(Date.UTC(Y,M-1,D+d));
    const y=wall.getUTCFullYear(),mo=wall.getUTCMonth()+1,day=wall.getUTCDate();
    const iso=`${y}-${String(mo).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const push=(mins:number)=>{if(mins>=0&&mins<=1440)marks.add(wallToInstant(y,mo,day,mins,zone));};
    for(let h=0;h<=24;h++)push(h*60);
    const wk=weekly?.[String(wall.getUTCDay())];
    if(wk?.mode==='working_hours'){push(minutes(wk.start??''));push(minutes(wk.end??''));}
    for(const e of settings.exceptions??[]){
      if(e.kind==='special_hours'&&inDateRange(iso,e.start_date,e.end_date,e.recurs_annually)){push(minutes(e.work_start??''));push(minutes(e.work_end??''));}
    }
    if(!weekly){push(minutes(settings.quiet_hours_start??''));push(minutes(settings.quiet_hours_end??''));}
  }
  for(const t of [...marks].sort((a,b)=>a-b)){
    if(t<=base)continue;
    const at=new Date(t);
    if(inside?!isWithinQuietHours(settings,at):isWithinQuietHours(settings,at)) return at;
  }
  return null;
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
