import type { AIFailure } from '../providers/ai/ai-provider.interface.js';
import { sendPlatformAlert } from './platform-alerts.service.js';
import { MODEL_ALERT_CONSECUTIVE_FAILURES, MODEL_ALERT_FAILURE_SHARE, MODEL_ALERT_MIN_CALLS, MODEL_ALERT_WINDOW_MS } from '../config/model-health.js';

type Outcome = { at: number; ok: boolean };
let outcomes: Outcome[] = [];
let consecutiveFailures = 0;
let down = false;
let alert: typeof sendPlatformAlert = sendPlatformAlert;

/**
 * Model health for the whole platform (single leya-api instance): alert after N consecutive failures
 * or ≥ share failures in the window (with a minimum number of calls); "recovered" on the first success
 * after a "down" alert. Telegram throttling (30 min per kind) lives in sendPlatformAlert.
 */
export function recordModelOutcome(ok: boolean, failure?: AIFailure, now = Date.now()): void {
  outcomes = [...outcomes.filter(o => now - o.at < MODEL_ALERT_WINDOW_MS), { at: now, ok }];
  consecutiveFailures = ok ? 0 : consecutiveFailures + 1;
  if (ok) {
    if (down) { down = false; void alert('model_recovered', '✅ Модель снова отвечает.').catch(() => undefined); }
    return;
  }
  const failed = outcomes.filter(o => !o.ok).length;
  const unhealthy = consecutiveFailures >= MODEL_ALERT_CONSECUTIVE_FAILURES
    || (outcomes.length >= MODEL_ALERT_MIN_CALLS && failed / outcomes.length >= MODEL_ALERT_FAILURE_SHARE);
  if (!unhealthy || down) return;
  down = true;
  const code = [failure?.httpStatus, failure?.providerStatus ?? failure?.reason].filter(Boolean).join(' ');
  void alert('model_down', `⚠️ Модель не отвечает: ${code || 'нет ответа'}. Клиенты получают ответ-заглушку.`).catch(() => undefined);
}

/** Test hook: reset state and capture alerts. */
export function resetModelHealth(capture?: typeof sendPlatformAlert): void {
  outcomes = []; consecutiveFailures = 0; down = false; alert = capture ?? sendPlatformAlert;
}
export const modelIsDown = () => down;
