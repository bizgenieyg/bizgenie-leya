import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionStatusFromWebhook } from './session-status.service.js';

test('WAHA session status webhook is recognized, message events are not', () => {
  assert.equal(sessionStatusFromWebhook({ event: 'session.status', payload: { status: 'SCAN_QR_CODE' } }), 'SCAN_QR_CODE');
  assert.equal(sessionStatusFromWebhook({ event: 'session.status', payload: { status: 'WORKING' } }), 'WORKING');
  assert.equal(sessionStatusFromWebhook({ event: 'message', payload: { status: 'FAILED' } }), null);
});
