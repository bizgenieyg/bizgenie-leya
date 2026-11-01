import type { DatabaseClient } from '../db/supabase.js';
import { CABINET_ONLY_SETTINGS, CHAT_SETTINGS, HELP_WORDS, LANGUAGE_WORDS, SETTING_LABELS, SETTING_VALUE_WORDS, START_ALL_WORDS, STOP_ALL_WORDS, type ChatSetting } from '../config/owner-chat.js';
import { insertProposal, stepFor, type Proposal, type Step, type Understanding } from './owner-rules.service.js';
import { invalidateOwnerSettings, loadOwnerSettings, type OwnerSettings } from './owner-settings.service.js';
import { behavior, saveRuntimeSettings } from './runtime-settings.service.js';
import { createException } from './schedule-exceptions.service.js';
import { renderText } from './templates.service.js';

/**
 * Z15: what the owner writes in «Нужен ответ» besides rules — «стоп» / «включи» at once, the hint list, settings from
 * the list in config/owner-chat.ts after «Было → станет. Сохранить? Да / Нет», one question with options 1/2/3 when
 * the message can be read in several ways. The model only proposes a key and a value; the code checks and applies.
 */
type Lang = 'ru' | 'he' | 'en';
const check = (error: unknown, message: string) => { if (error) throw new Error(message); };
const lang = (settings: OwnerSettings): Lang => { const l = behavior(settings).owner_language; return l === 'he' || l === 'en' ? l : 'ru'; };
const whole = (text: string) => text.trim().toLowerCase().replace(/[.!?…]+$/g, '').replace(/ё/g, 'е').trim();
const time = (v: unknown): v is string => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const bool = (v: unknown) => v === true || v === 'true' ? true : v === false || v === 'false' ? false : null;

/** The whole message is an instant command: «стоп», «включи», «что ты умеешь?» — answered without the model. */
export function instantCommand(text: string): 'stop' | 'start' | 'help' | null {
  const t = whole(text);
  if (STOP_ALL_WORDS.includes(t)) return 'stop';
  if (START_ALL_WORDS.includes(t)) return 'start';
  return HELP_WORDS.includes(t) ? 'help' : null;
}
export const helpText = (settings: OwnerSettings) => renderText(settings, 'owner.help', lang(settings));

/** «Стоп» / «включи»: all replies to clients off / on (the same setting as in the cabinet). */
export async function setAllPaused(db: DatabaseClient, tenantId: string, paused: boolean): Promise<string> {
  await saveRuntimeSettings(db, tenantId, { auto_replies_paused: paused });
  const settings = await loadOwnerSettings(db, tenantId);
  return renderText(settings, paused ? 'owner.paused_all' : 'owner.resumed_all', lang(settings));
}

/** The value the code accepts for a key, or undefined (the model's value is never applied as is). */
export function normalizeSetting(key: string, value: unknown): { key: ChatSetting; value: unknown } | null {
  if (!(CHAT_SETTINGS as readonly string[]).includes(key)) return null;
  const k = key as ChatSetting, o = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  switch (k) {
    case 'quiet_hours':
      if (value === null || value === false || value === 'off') return { key: k, value: null };
      return o && time(o.start) && time(o.end) && o.start !== o.end ? { key: k, value: { start: o.start, end: o.end } } : null;
    case 'day_off': {
      if (!o || !date(o.start_date)) return null;
      const end = date(o.end_date) ? o.end_date : o.start_date;
      if (end < o.start_date) return null;
      const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 120) : '';
      return { key: k, value: { start_date: o.start_date, end_date: end, name } };
    }
    case 'daily_report_enabled': case 'polish_owner_answer': case 'auto_replies_paused': { const b = bool(value); return b === null ? null : { key: k, value: b }; }
    case 'daily_report_time': return time(value) ? { key: k, value } : null;
    case 'auto_resume_hours': { const n = Number(value); return Number.isSafeInteger(n) && n >= 1 && n <= 48 ? { key: k, value: n } : null; }
    case 'assistant_name': return typeof value === 'string' && value.trim() && value.trim().length <= 60 && !/[<>{}]/.test(value) ? { key: k, value: value.trim() } : null;
    case 'owner_language': return value === 'ru' || value === 'he' || value === 'en' ? { key: k, value } : null;
  }
}

async function assistantName(db: DatabaseClient, tenantId: string): Promise<string | null> {
  const r = await db.from('assistant_profiles').select('assistant_name').eq('tenant_id', tenantId).maybeSingle();check(r.error, 'Assistant profile lookup failed');
  return typeof r.data?.assistant_name === 'string' && r.data.assistant_name.trim() ? r.data.assistant_name.trim() : null;
}
/** A value in the owner's words: «22:00–08:00», «включено», «иврит». */
function shown(settings: OwnerSettings, key: ChatSetting, value: unknown): string {
  const l = lang(settings), word = (w: keyof typeof SETTING_VALUE_WORDS) => SETTING_VALUE_WORDS[w][l];
  if (value === null || value === undefined || value === '') return word(key === 'quiet_hours' ? 'off' : 'none');
  if (key === 'quiet_hours') { const v = value as { start: string; end: string }; return `${v.start}–${v.end}`; }
  if (key === 'day_off') { const v = value as { start_date: string; end_date: string; name: string }; return `${v.start_date === v.end_date ? v.start_date : `${v.start_date} – ${v.end_date}`}${v.name ? ` (${v.name})` : ''}`; }
  if (key === 'auto_replies_paused') return word(value ? 'paused' : 'running');
  if (typeof value === 'boolean') return word(value ? 'on' : 'off');
  if (key === 'owner_language') return LANGUAGE_WORDS[value as Lang]?.[l] ?? String(value);
  return String(value);
}
async function currentValue(db: DatabaseClient, tenantId: string, settings: OwnerSettings, key: ChatSetting): Promise<unknown> {
  const config = behavior(settings);
  switch (key) {
    case 'quiet_hours': return settings.quiet_hours_start && settings.quiet_hours_end ? { start: settings.quiet_hours_start, end: settings.quiet_hours_end } : null;
    case 'day_off': return null;
    case 'auto_replies_paused': return settings.auto_replies_paused;
    case 'assistant_name': return await assistantName(db, tenantId);
    default: return (config as Record<string, unknown>)[key];
  }
}

async function cabinetLink(db: DatabaseClient, settings: OwnerSettings, section: string): Promise<string> {
  const row = await db.from('system_config').select('value').eq('key', 'cabinet_url').maybeSingle();check(row.error, 'System config lookup failed');
  const base = typeof row.data?.value === 'string' ? row.data.value.trim().replace(/\/+$/, '') : '';
  return base ? `${base}/admin/settings?section=${section}` : SETTING_LABELS.cabinet[lang(settings)];
}

/** «Было → станет. Сохранить?» for a setting from the list; a cabinet-only setting — the link to its section. */
export async function proposeSetting(db: DatabaseClient, tenantId: string, settings: OwnerSettings, raw: { key: string; value: unknown } | null | undefined): Promise<Step> {
  const l = lang(settings);
  const section = raw ? CABINET_ONLY_SETTINGS[raw.key] : undefined;
  if (section) return { reply: renderText(settings, 'owner.setting_cabinet', l, { link: await cabinetLink(db, settings, section) }), proposal: null, kind: 'setting' };
  const setting = raw ? normalizeSetting(raw.key, raw.value) : null;
  if (!setting) return { reply: renderText(settings, 'owner.setting_invalid', l), proposal: null, kind: 'setting' };
  const before = await currentValue(db, tenantId, settings, setting.key);
  const p = await insertProposal(db, tenantId, { action: 'setting', status: 'pending', source: 'whatsapp', payload: { key: setting.key, value: setting.value } });
  return { reply: renderText(settings, 'owner.setting_confirm', l, { setting: SETTING_LABELS[setting.key][l], from: shown(settings, setting.key, before), to: shown(settings, setting.key, setting.value) }), proposal: p, kind: 'setting' };
}

/** «Да» to a setting: claimed once (pending → applied), then applied through the same save as the cabinet. */
export async function applySetting(db: DatabaseClient, tenantId: string, settings: OwnerSettings, p: Proposal,
  onRename?: () => Promise<void>): Promise<string> {
  const l = lang(settings);
  const setting = normalizeSetting(String(p.payload?.key ?? ''), p.payload?.value);
  const claimed = await db.from('owner_rule_proposals').update({ status: 'applied', decided_at: new Date().toISOString() }).eq('id', p.id).eq('status', 'pending').select('id');
  check(claimed.error, 'Proposal update failed');
  if (!claimed.data?.length || !setting) return renderText(settings, 'owner.setting_invalid', l);
  const v = setting.value as Record<string, string> | null;
  if (setting.key === 'quiet_hours') await saveRuntimeSettings(db, tenantId, { quiet_hours_start: v?.start ?? null, quiet_hours_end: v?.end ?? null });
  else if (setting.key === 'day_off') {
    await createException(db, tenantId, { start_date: v!.start_date, end_date: v!.end_date, kind: 'day_off', name: v!.name || SETTING_LABELS.day_off[l], recurs_annually: false });
    const { rescheduleTenantEscalationTimeouts } = await import('./owner-workflow.service.js');
    await rescheduleTenantEscalationTimeouts(db, tenantId, await loadOwnerSettings(db, tenantId));
  } else await saveRuntimeSettings(db, tenantId, { [setting.key]: setting.value });
  invalidateOwnerSettings(db, tenantId);
  // The owner groups carry the assistant name and are named in the owner's language.
  if ((setting.key === 'assistant_name' || setting.key === 'owner_language') && onRename) { try { await onRename(); } catch { console.warn('owner_channel_rename_failed', { tenantId }); } }
  return renderText(await loadOwnerSettings(db, tenantId), 'owner.setting_saved', lang(await loadOwnerSettings(db, tenantId)));
}
export async function declineSetting(db: DatabaseClient, settings: OwnerSettings, p: Proposal): Promise<string> {
  check((await db.from('owner_rule_proposals').update({ status: 'declined', decided_at: new Date().toISOString() }).eq('id', p.id)).error, 'Proposal update failed');
  return renderText(settings, p.action === 'support' ? 'owner.support_declined' : 'owner.setting_declined', lang(settings));
}

/** «Неоднозначно»: one question with the options 1/2/3; nothing is saved until the chosen option gets its «Да». */
export async function proposeChoice(db: DatabaseClient, tenantId: string, settings: OwnerSettings, u: Understanding): Promise<Step> {
  const options = u.options ?? [];
  const p = await insertProposal(db, tenantId, { action: 'choice', status: 'pending', source: 'whatsapp', payload: { options } });
  return { reply: renderText(settings, 'owner.choice', lang(settings), { question: u.answer ?? '', options: options.map((o, i) => `${i + 1}. ${o.label}`).join('\n') }).trim(), proposal: p, kind: 'ambiguous' };
}
/** The owner answered a digit: the chosen option becomes the usual proposal (a rule or a setting) — still with «Да». */
export async function pickChoice(db: DatabaseClient, tenantId: string, settings: OwnerSettings, p: Proposal, text: string): Promise<Step | null> {
  const options = (p.payload?.options ?? []) as NonNullable<Understanding['options']>;
  const n = Number(whole(text));
  const option = Number.isSafeInteger(n) ? options[n - 1] : undefined;
  if (!option) return null;
  check((await db.from('owner_rule_proposals').update({ status: 'superseded', decided_at: new Date().toISOString() }).eq('id', p.id)).error, 'Proposal update failed');
  if (option.kind === 'setting') return proposeSetting(db, tenantId, settings, option.setting);
  return stepFor(db, tenantId, settings, { kind: 'add_rule', number: null, rule: option.rule ?? option.label, fact: null, factTopic: null, conflict: null, needsDetails: null, answer: null }, 'whatsapp');
}
