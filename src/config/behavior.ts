/** Null database overrides inherit these system defaults on every request. */
export const BEHAVIOR_DEFAULTS = {
  translate_owner_answer: false,
  escalation_remind_minutes: 120,
  escalation_close_minutes: 1440,
  auto_resume_hours: 0,
  deferred_max_age_hours: 12,
  context_message_count: 10,
  context_retention_hours: 48,
  message_retention_days: 30,
  usage_failure_alert_minutes: 60,
  pairing_ttl_minutes: 30,
  scheduler_interval_seconds: 60,
  stt_confidence_threshold: 0.85,
  stt_timeout_seconds: 30,
  media_max_bytes: 10 * 1024 * 1024,
  owner_language: 'ru',
  cabinet_language: null as 'ru'|'en'|'he'|null,
  weekly_schedule: null as WeeklySchedule | null,
  agent_overrides: {} as Record<string,{priority?:number;keywords?:string[];systemPrompt?:string}>,
  enabled_agents: ['SALE','SUPPORT'],
  campaign_routes: [] as Array<{keyword:string;agent:string}>,
  source_routes: [] as Array<{source:string;agent:string}>,
  intent_confidence_threshold: 0.75,
  route_stickiness_hours: 24,
  reception_max_messages: 0,
  summary_frequency: 'weekly' as 'off'|'daily'|'weekly',
  summary_time: '09:00',
  summary_weekday: 1,
};
export const SCHEDULER_POLL_MS = 1000;
// Message storage retention: floor for behavior.message_retention_days, and how often
// the scheduler runs the background sweep per tenant.
export const MESSAGE_RETENTION_MIN_DAYS = 7;
export const MESSAGE_RETENTION_SWEEP_MS = 60 * 60 * 1000;
export const STT_DEFAULT_MODEL = 'gemini-2.5-flash-lite';
// Local operational storage, shared by workers on the supported single VPS.
export const ALERT_STATE_DIR = '.runtime/usage-alerts';
export const ALERT_LOCK_STALE_MS = 60_000;
export const MAX_SCHEDULE_LOOKAHEAD_MINUTES = 370 * 24 * 60;

export type DaySchedule =
  | { mode: 'working_day' }
  | { mode: 'day_off' }
  | { mode: 'working_hours'; start: string; end: string };
export type WeeklySchedule = Record<'0'|'1'|'2'|'3'|'4'|'5'|'6', DaySchedule>;
