import assert from 'node:assert/strict';
import test from 'node:test';
import { alertAllowed, safeAlertLabel, sendPlatformAlert } from './platform-alerts.service.js';

test('alert suppression uses a 30-minute kind and tenant window', () => {
  const sent = new Map([['session_down:tenant-a', 1000]]);
  assert.equal(alertAllowed('session_down', 'tenant-a', 1000 + 29 * 60_000, sent), false);
  assert.equal(alertAllowed('session_down', 'tenant-a', 1000 + 30 * 60_000, sent), true);
  assert.equal(alertAllowed('session_down', 'tenant-b', 1000 + 1000, sent), true);
  assert.equal(alertAllowed('session_recovered', 'tenant-a', 1000 + 1000, sent), true);
});

test('alert labels never expose full numbers', () => {
  assert.equal(safeAlertLabel('Salon +972 50 123 4567'), 'Salon ••••4567');
});

test('missing Telegram environment does not throw', async () => {
  // In local test environments the bot credentials are deliberately absent.
  if (process.env.TELEGRAM_ALERT_BOT_TOKEN || process.env.TELEGRAM_ALERT_CHAT_ID) return;
  assert.equal(await sendPlatformAlert('test_missing_env', 'test'), false);
});
