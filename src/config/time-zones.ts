export const DEFAULT_TIME_ZONE = 'Asia/Jerusalem';

// Product-supported IANA zones. Extend this config without changing validation logic.
const UTC_OFFSETS=Array.from({length:27},(_,i)=>i-12).map(offset=>offset===0?'UTC':`UTC${offset>0?'+':''}${offset}`);
export const SUPPORTED_TIME_ZONES = Object.freeze([
  'Asia/Jerusalem', 'Europe/London', 'Europe/Paris', 'Europe/Berlin',
  'Europe/Moscow', 'Europe/Kyiv', 'Asia/Tbilisi', 'Asia/Dubai',
  'America/New_York', 'America/Chicago', 'America/Denver',
  'America/Los_Angeles', 'America/Toronto', 'America/Sao_Paulo',
  'Asia/Tokyo', 'Asia/Singapore', 'Australia/Sydney',
  ...UTC_OFFSETS,
]);

export function supportedTimeZone(value: unknown): value is string {
  return typeof value === 'string' && SUPPORTED_TIME_ZONES.includes(value as typeof SUPPORTED_TIME_ZONES[number]);
}

export function intlTimeZone(value:string):string {
 const match=/^UTC([+-])(\d{1,2})$/.exec(value);if(!match)return value;
 return `Etc/GMT${match[1]==='+'?'-':'+'}${Number(match[2])}`;
}
