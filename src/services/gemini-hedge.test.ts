import assert from 'node:assert/strict';
import test from 'node:test';
import { hedgedFetch } from '../providers/ai/gemini.provider.js';

const wait = (ms: number, signal: AbortSignal, value: string) => new Promise<Response>((resolve, reject) => {
  const timer = setTimeout(() => resolve(new Response(value)), ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
});

test('Z18: a fast reply is not hedged — one request', async () => {
  let calls = 0;
  const response = await hedgedFetch(signal => { calls++; return wait(5, signal, 'first'); }, 50);
  assert.equal(await response.text(), 'first'); assert.equal(calls, 1);
});

test('Z18: a slow reply gets a second request; the first answer wins and the slow one is aborted', async () => {
  const aborted: boolean[] = []; let hedged = 0;
  const response = await hedgedFetch(signal => { const i = aborted.push(false) - 1; signal.addEventListener('abort', () => { aborted[i] = true; });
    return wait(i === 0 ? 500 : 10, signal, i === 0 ? 'slow' : 'second'); }, 20, () => hedged++);
  assert.equal(await response.text(), 'second'); assert.deepEqual(aborted, [true, false]); assert.equal(hedged, 1);
});

test('Z18: the first request still wins when it answers after the hedge but before the second', async () => {
  const aborted: boolean[] = [];
  const response = await hedgedFetch(signal => { const i = aborted.push(false) - 1; signal.addEventListener('abort', () => { aborted[i] = true; });
    return wait(i === 0 ? 30 : 500, signal, i === 0 ? 'first' : 'second'); }, 20);
  assert.equal(await response.text(), 'first'); assert.deepEqual(aborted, [false, true]);
});

test('Z18: both requests fail — the error is thrown; 0 turns hedging off', async () => {
  await assert.rejects(hedgedFetch(() => Promise.reject(new Error('down')), 0), /down/);
  let calls = 0;
  await assert.rejects(hedgedFetch(async signal => { calls++; await wait(40, signal, ''); throw new Error(`down ${calls}`); }, 10), /down/);
  assert.equal(calls, 2);
});
