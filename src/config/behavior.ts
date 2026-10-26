/** Null database overrides inherit these system defaults on every request. */
export const BEHAVIOR_DEFAULTS = {
  translate_owner_answer: false,
  polish_owner_answer: true,
  client_discovery_questions: [] as string[],
  escalation_remind_minutes: 120,
  escalation_close_minutes: 1440,
  /** Task Z: the assistant comes back 1 hour after the owner's last message in the chat (owners do not type commands). */
  auto_resume_hours: 1,
  deferred_max_age_hours: 12,
  /** Z10: how often an owner group is checked to still exist before a message goes to it (operator). */
  owner_channel_check_minutes: 60,
  /** Z11: owner rules — at most this many active, each this long; an unanswered «Сохранить?» expires after these hours (operator). */
  owner_rules_max: 30,
  owner_rule_max_chars: 300,
  owner_rule_pending_hours: 24,
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
  /** Cosine similarity at or above which a reply repeats one of the last bot replies in meaning (task Q). */
  semantic_repeat_threshold: 0.9,
  /** How many previous bot replies a new reply is compared with. */
  repeat_window: 3,
  /** Client messages during which an offer to pass the request to the owner awaits an answer. */
  request_offer_turns: 2,
  /** The same call to action (demo, booking, passing to the owner) at most once per this many client turns. */
  cta_min_gap_turns: 3,
  /** Where answers take knowledge from (task R): 'legacy' — Q&A pairs and files, 'facts' — the business profile. */
  knowledge_mode: 'legacy' as 'legacy' | 'facts',
  /** A new fact at least this similar (cosine) to an active fact of the same topic is a duplicate. */
  fact_duplicate_threshold: 0.92,
  /** Facts found by embeddings (non-core topics) when the whole profile does not fit knowledge_full_context_chars. */
  facts_search_results: 12,
  /** Longest pasted text for "Добавить что угодно". */
  source_text_max_chars: 50_000,
  /** Long sources are extracted in parts of about this many characters (task W: one part of 6 350 chars kept ~21
   *  facts of ~45 Q&A pairs; ~2 500 chars ≈ 15 pairs per call keeps the answer short enough to list every one). */
  extraction_chunk_chars: 2_500,
  /** Links: download timeout, page size and how many inner pages of the same site are read. */
  link_timeout_seconds: 15,
  link_max_bytes: 2 * 1024 * 1024,
  link_max_pages: 5,
  /** Open improvement cards per tenant. */
  audit_max_open_cards: 10,
  /** Task Z: 'legacy' — the rules/JSON path; 'instruction' — core + business instruction + facts, text with labels. */
  reply_engine: 'instruction' as 'legacy' | 'instruction',
  /** Answer model for the instruction path; empty — the current reply model (GEMINI_MODEL). Z6: one scheme for all. */
  reply_model: 'gemini-3.8-flash',
  /** Task Z4: one attempt on this model when the reply model is down (timeout / unavailable / 5xx); empty — none.
   *  Prefix picks the provider: gemini- / claude- / gpt-. */
  reply_fallback_model: 'gpt-6.1-sol',
  /** Z6: the instruction template of a tenant without its own instruction (service_booking | order | project | b2b |
   *  general); empty — derived from business_sector (config/instruction-templates.ts). */
  instruction_template: '',
  /** Task Z2: output cap of the reply model (thinking + text together on Gemini 3.x); one retry with the larger
   *  cap after 'incomplete_max_tokens'. 1024 cut 33 replies of gemini-3.8-flash in Z1. */
  reply_max_output_tokens: 2048,
  reply_retry_max_output_tokens: 4096,
  /** Thinking level per reply model (Gemini generationConfig.thinkingConfig.thinkingLevel); a model not listed gets
   *  none — its own default (gemini-3.5-flash-lite: minimal). 3.8-flash defaults to 'medium': 'low' for latency. */
  reply_thinking_levels: { 'gemini-3.8-flash': 'low' } as Record<string, string>,
  /** Z4: the reply model call — whole call, one HTTP attempt, pause before the one retry on 429/5xx/network. */
  reply_timeout_ms: 20_000,
  reply_attempt_timeout_ms: 9_000,
  reply_retry_delay_ms: 1_500,
  /** Fields a request of each type must carry before it is created. */
  request_required_fields: { meeting: ['topic'], consultation: ['city', 'when'], procedure: ['service', 'city', 'when', 'allergy'],
    booking: ['service', 'when'], reschedule: ['when'], cancel: [], order: ['items', 'date'], estimate: ['task'], request: ['what'] } as Record<string, string[]>,
  /** Demo mode ("покажу на примере") closes after this many client turns. */
  demo_max_turns: 6,
  /** Owner interview: questions on the first day, then per day. */
  owner_interview_first_batch: 12,
  owner_interview_daily_limit: 2,
  /** Voice notes in "Добавить знания": longest note and service limits per tenant. */
  knowledge_voice_max_seconds: 180,
  knowledge_voice_hourly_limit: 5,
  knowledge_voice_daily_limit: 20,
};
// Message storage retention: floor for behavior.message_retention_days, and daily sweep cadence.
export const MESSAGE_RETENTION_MIN_DAYS = 7;
export const MESSAGE_RETENTION_SWEEP_MS = 24 * 60 * 60 * 1000;
/** Task Z2: the task model (fact extraction, audit) is system-wide, not per tenant: defaults here, overridable by
 *  GEMINI_TASK_MAX_OUTPUT_TOKENS and GEMINI_TASK_THINKING_LEVEL. 8192 with the default 'medium' thinking could not
 *  extract ira-facts.md even in 600-character parts. */
export const TASK_MODEL_LIMITS = { maxOutputTokens: 16_384, retryMaxOutputTokens: 32_768, thinkingLevels: { 'gemini-3.8-flash': 'low' } as Record<string, string> };
/** System defaults of one model call (any provider) when the caller sets nothing: replies take the tenant's
 *  reply_* settings above, the task model its own options. */
export const MODEL_CALL_DEFAULTS = { timeoutMs: 20_000, attemptTimeoutMs: 9_000, retryDelayMs: 1_500 };
/** Z4: the judge of eval:instructions, pinned so that comparisons do not follow GEMINI_TASK_MODEL. */
export const EVAL_JUDGE_MODEL = 'gemini-3.8-flash';
export const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'] as const;
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
