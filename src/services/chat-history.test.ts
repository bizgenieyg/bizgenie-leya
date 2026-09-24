import assert from 'node:assert/strict';
import test from 'node:test';
import type { WhatsAppChatMessage, WhatsAppProvider } from '../providers/whatsapp/whatsapp-provider.interface.js';
import { fetchChatHistory } from './chat-history.service.js';

const options = { limit: 30, maxCharacters: 21, timeoutSeconds: 5 };
const provider = (rows: WhatsAppChatMessage[] | Error, seen: unknown[] = []): WhatsAppProvider => ({
  async sendMessage() { return { id: 'x' }; }, async getSessionStatus() { return { status: 'WORKING' }; },
  async getChatMessages(...args) { seen.push(args); if (rows instanceof Error) throw rows; return rows; },
});
const row = (id: string, timestamp: number, body: string, fromMe = false, hasMedia = false) => ({ id, timestamp, body, fromMe, hasMedia });

test('history is chronological, text only, excludes the current batch and trims the oldest', async () => {
  const seen: unknown[] = [];
  const result = await fetchChatHistory(provider([
    row('false_1@lid_C', 30, 'текущее'), row('true_1@lid_B', 20, 'ответ', true), row('false_1@lid_M', 15, '', false, true),
    row('false_1@lid_A', 10, 'старое сообщение'), row('false_1@lid_Z', 5, 'самое старое'),
  ], seen), 's', '1@lid', ['C'], options);
  assert.deepEqual(result.map(m => [m.fromMe, m.text]), [[false, 'старое сообщение'], [true, 'ответ']]);
  assert.deepEqual(seen, [['s', '1@lid', { limit: 30, timeoutMs: 5000 }]]);
});

test('provider error, missing capability or empty history yields no history', async () => {
  assert.deepEqual(await fetchChatHistory(provider(new Error('timeout')), 's', '1@lid', [], options), []);
  assert.deepEqual(await fetchChatHistory(provider([]), 's', '1@lid', [], options), []);
  const bare: WhatsAppProvider = { async sendMessage() { return { id: 'x' }; }, async getSessionStatus() { return { status: 'WORKING' }; } };
  assert.deepEqual(await fetchChatHistory(bare, 's', '1@lid', [], options), []);
});

test('media rows are excluded even when they carry a caption', async () => {
  const result = await fetchChatHistory(provider([row('a', 1, 'Фото с подписью', false, true), row('b', 2, 'Текст')]), 's', '1@lid', [], { ...options, maxCharacters: 1000 });
  assert.deepEqual(result.map(m => m.text), ['Текст']);
});
