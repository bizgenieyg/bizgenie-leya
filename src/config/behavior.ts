/** Null database overrides inherit these system defaults on every request. */
export const BEHAVIOR_DEFAULTS = {
  translate_owner_answer: false,
  polish_owner_answer: true,
  client_discovery_questions: [] as string[],
  escalation_remind_minutes: 120,
  escalation_close_minutes: 1440,
  auto_resume_hours: 4,
  deferred_max_age_hours: 12,
  context_message_count: 10,
  context_retention_hours: 48,
  history_fetch_limit: 30,
  history_max_characters: 6000,
  history_timeout_seconds: 5,
  lid_lookup_timeout_seconds: 5,
  lid_backfill_pause_ms: 1_000,
  inbound_quiet_seconds: 6,
  outbound_typing_min_seconds: 2,
  outbound_typing_max_seconds: 8,
  outbound_typing_seconds_per_100_min: 1.5,
  outbound_typing_seconds_per_100_max: 2.5,
  outbound_conversation_gap_min_seconds: 3,
  outbound_conversation_gap_max_seconds: 10,
  outbound_proactive_gap_min_seconds: 25,
  outbound_proactive_gap_max_seconds: 90,
  outbound_reminder_spread_minutes: 20,
  daily_proactive_limit: 30,
  outbound_retry_delays_seconds: [30, 120, 300] as number[],
  outbound_retention_days: 7,
  message_retention_days: 30,
  usage_failure_alert_minutes: 60,
  pairing_ttl_minutes: 30,
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
  simulator_hourly_limit: 30,
  simulator_daily_limit: 100,
  summary_frequency: 'weekly' as 'off'|'daily'|'weekly',
  summary_time: '09:00',
  summary_weekday: 1,
  knowledge_max_files: 10,
  knowledge_max_file_bytes: 10 * 1024 * 1024,
  knowledge_max_total_bytes: 50 * 1024 * 1024,
  knowledge_max_pdf_pages: 200,
  knowledge_max_characters: 500_000,
  knowledge_search_results: 8,
  knowledge_full_context_chars: 40_000,
  knowledge_unit_max_chars: 3_000,
  knowledge_similarity_floor: 0.5,
  knowledge_similarity_threshold: 0.72,
  knowledge_indexing_hourly_limit: 10,
  knowledge_indexing_daily_limit: 20,
  knowledge_chunk_characters: 1500,
  knowledge_chunk_overlap: 225,
};
// Message storage retention: floor for behavior.message_retention_days, and daily sweep cadence.
export const MESSAGE_RETENTION_MIN_DAYS = 7;
export const MESSAGE_RETENTION_SWEEP_MS = 24 * 60 * 60 * 1000;
export const STT_DEFAULT_MODEL = 'gemini-2.5-flash-lite';
// Local operational storage, shared by workers on the supported single VPS.
export const ALERT_STATE_DIR = '.runtime/usage-alerts';
export const SIMULATOR_LIMIT_STATE_DIR = '.runtime/simulator-limits';
export const ALERT_LOCK_STALE_MS = 60_000;
export const MAX_SCHEDULE_LOOKAHEAD_MINUTES = 370 * 24 * 60;

export type DaySchedule =
  | { mode: 'working_day' }
  | { mode: 'day_off' }
  | { mode: 'working_hours'; start: string; end: string };
export type WeeklySchedule = Record<'0'|'1'|'2'|'3'|'4'|'5'|'6', DaySchedule>;
