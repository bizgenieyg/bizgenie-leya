import type { OwnerSettings } from './owner-settings.service.js';
import { renderText } from './templates.service.js';
import { REQUEST_FIELD_LABELS, REQUEST_FIELD_OTHER, REQUEST_TYPE_LABELS, REQUEST_TYPE_OTHER } from '../config/request-labels.js';

type Lang = 'ru' | 'he' | 'en';
const lang = (language: string): Lang => (['ru', 'he', 'en'].includes(language) ? language : 'ru') as Lang;

/** A request summary as stored from the label: the type on the first line, then «key: value» lines. */
export function parseRequestSummary(summary: string): { type: string; fields: Record<string, string> } {
  const [first = '', ...rest] = summary.split('\n').map(line => line.trim()).filter(Boolean);
  const fields: Record<string, string> = {};
  for (const line of rest) { const m = /^([a-z][a-z0-9_]{0,39}):\s*(.+)$/.exec(line); if (m) fields[m[1]!] = m[2]!; }
  return { type: /^[a-z][a-z0-9_]{0,39}$/.test(first) ? first : '', fields };
}

/**
 * Z14: the owner's card when the model wrote none — the request type and fields in the owner's words (never the label
 * keys) and the client's last 1–3 messages verbatim.
 */
export function fallbackRequestCard(settings: OwnerSettings, language: string, input: { name: string; type: string; fields: Record<string, string>; clientMessages?: string[] }): string {
  const l = lang(language);
  const { name: fieldName, ...fields } = input.fields;
  const type = (REQUEST_TYPE_LABELS[input.type] ?? REQUEST_TYPE_OTHER)[l];
  const lines = Object.entries(fields).filter(([, v]) => v.trim() && v.trim() !== '…').map(([k, v]) => `• ${(REQUEST_FIELD_LABELS[k] ?? REQUEST_FIELD_OTHER)[l]}: ${v.trim().slice(0, 200)}`);
  const said = (input.clientMessages ?? []).map(m => m.trim()).filter(Boolean).slice(-3).map(m => `«${m.slice(0, 300)}»`);
  return renderText(settings, 'owner.request_fallback_card', l, { name: fieldName?.trim() || input.name || '—', type,
    fields: lines.length ? `\n${lines.join('\n')}` : '',
    messages: said.length ? `\n${renderText(settings, 'owner.request_fallback_messages', l, { messages: said.join('\n') })}` : '' });
}
