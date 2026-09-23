import { behavior } from './runtime-settings.service.js';
import { activeElapsedMs, isWithinQuietHours, nextQuietHoursEnd } from './escalation.service.js';
import type { OwnerSettings } from './owner-settings.service.js';

export interface EscalationDeadlineState {
  created_at?: string;
  pending_since?: string | null;
  reminded_at?: string | null;
}

/** Earliest instant when the next existing reminder/close rule can change state. */
export function nextEscalationDeadline(settings: OwnerSettings, state: EscalationDeadlineState, now: Date): Date {
  const config = behavior(settings);
  const created = new Date(state.created_at ?? now);
  const started = new Date(state.pending_since ?? state.created_at ?? now);
  const expiry = new Date(created.getTime() + Number(config.deferred_max_age_hours) * 3_600_000 + 1);
  const target = Number(state.reminded_at ? config.escalation_close_minutes : config.escalation_remind_minutes) * 60_000;
  let remaining = target - activeElapsedMs(settings, started, now);
  let cursor = now;
  if (remaining <= 0) return now < expiry ? now : expiry;
  for (let step = 0; step < 1_000; step++) {
    const quiet = isWithinQuietHours(settings, cursor);
    const transition = nextQuietHoursEnd(settings, cursor);
    if (quiet) {
      if (!transition) return expiry;
      cursor = transition;
      if (cursor >= expiry) return expiry;
      continue;
    }
    if (!transition || cursor.getTime() + remaining <= transition.getTime()) {
      const due = new Date(cursor.getTime() + remaining);
      return due < expiry ? due : expiry;
    }
    remaining -= transition.getTime() - cursor.getTime();
    cursor = transition;
    if (cursor >= expiry) return expiry;
  }
  return expiry;
}
