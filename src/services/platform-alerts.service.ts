import { env } from '../config/env.js';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WINDOW_MS = 30 * 60_000;
const lastSent = new Map<string, number>();
const throttleFile = join(tmpdir(), 'leya-platform-alert-throttle.json');
let throttleLoaded = false;
async function loadThrottle(): Promise<void> {
  if (throttleLoaded) return;
  throttleLoaded = true;
  try {
    const stored: unknown = JSON.parse(await readFile(throttleFile, 'utf8'));
    if (stored && typeof stored === 'object' && !Array.isArray(stored))
      for (const [key, value] of Object.entries(stored)) if (typeof value === 'number' && Number.isFinite(value)) lastSent.set(key, value);
  } catch { /* First launch or damaged cache: alerts remain available. */ }
}
async function saveThrottle(): Promise<void> {
  const fresh = [...lastSent].filter(([, at]) => Date.now() - at < WINDOW_MS);
  const temporary = `${throttleFile}.${process.pid}`;
  try {
    await writeFile(temporary, JSON.stringify(Object.fromEntries(fresh)), { mode: 0o600 });
    await rename(temporary, throttleFile);
  } catch { console.error('platform_alert_throttle_persist_failed'); }
}
export function alertAllowed(kind: string, tenantId: string | undefined, now: number, sent: Map<string, number> = lastSent): boolean {
  const previous = sent.get(`${kind}:${tenantId ?? 'platform'}`);
  return previous === undefined || now - previous >= WINDOW_MS;
}

/** Only operational metadata is accepted here. Callers must not pass customer text. */
export async function sendPlatformAlert(kind: string, text: string, tenantId?: string, options: { every?: boolean } = {}): Promise<boolean> {
  const key = `${kind}:${tenantId ?? 'platform'}`;
  const now = Date.now();
  if (!options.every) await loadThrottle();
  if (!options.every && !alertAllowed(kind, tenantId, now)) return false;
  // Never log the message: feedback may contain personal data.
  if (!env.telegramAlertBotToken || !env.telegramAlertChatId) {
    console.warn('platform_alert_not_configured', { kind, tenantId });
    return false;
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.telegramAlertBotToken}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.telegramAlertChatId, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('Telegram rejected alert');
    if (!options.every) { lastSent.set(key, now); await saveThrottle(); }
    return true;
  } catch {
    console.error('platform_alert_send_failed', { kind, tenantId });
    return false;
  }
}

export function redactPhoneNumbers(value: string): string {
  return value.replace(/\+?\d[\d\s()-]{5,}\d/g, match => `••••${match.replace(/\D/g, '').slice(-4)}`);
}
export function safeAlertLabel(value: unknown): string {
  return redactPhoneNumbers(String(value ?? '')).replace(/[\r\n\t]/g, ' ').slice(0, 100);
}
