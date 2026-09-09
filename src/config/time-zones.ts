export const DEFAULT_TIME_ZONE = 'Asia/Jerusalem';

// Product-supported IANA zones. Extend this config without changing validation logic.
export const SUPPORTED_TIME_ZONES = Object.freeze([
  'Asia/Jerusalem', 'Europe/London', 'Europe/Paris', 'Europe/Berlin',
  'Europe/Moscow', 'Europe/Kyiv', 'Asia/Tbilisi', 'Asia/Dubai',
  'America/New_York', 'America/Chicago', 'America/Denver',
  'America/Los_Angeles', 'America/Toronto', 'America/Sao_Paulo',
  'Asia/Tokyo', 'Asia/Singapore', 'Australia/Sydney',
]);

export function supportedTimeZone(value: unknown): value is string {
  return typeof value === 'string' && SUPPORTED_TIME_ZONES.includes(value as typeof SUPPORTED_TIME_ZONES[number]);
}
