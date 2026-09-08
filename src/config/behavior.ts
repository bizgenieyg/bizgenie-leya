/** Null database overrides inherit these system defaults on every request. */
export const BEHAVIOR_DEFAULTS = {
  translate_owner_answer: false,
  escalation_remind_minutes: 120,
  escalation_close_minutes: 1440,
  usage_failure_alert_minutes: 60,
  pairing_ttl_minutes: 30,
  scheduler_interval_seconds: 60,
  stt_confidence_threshold: 0.85,
  stt_timeout_seconds: 30,
  media_max_bytes: 10 * 1024 * 1024,
  owner_language: 'ru',
  agent_overrides: {} as Record<string,{priority?:number;keywords?:string[];systemPrompt?:string}>,
  default_agent: 'SUPPORT',
  enabled_agents: ['SALE','SUPPORT'],
};
export const SCHEDULER_POLL_MS = 1000;
export const STT_DEFAULT_MODEL = 'gemini-2.5-flash-lite';
// Local operational storage, shared by workers on the supported single VPS.
export const ALERT_STATE_DIR = '.runtime/usage-alerts';
export const ALERT_LOCK_STALE_MS = 60_000;
