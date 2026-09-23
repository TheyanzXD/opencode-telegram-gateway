// language: JavaScript (Node 20+ ESM), file: tests/dispatcher-flood.test.mjs
// Acceptance: a burst of sends must never exceed the global or per-chat rate,
// and a 429 must back off and re-queue, not drop the message.

import test from 'node:test';
import assert from 'node:assert/strict';

import { TelegramDispatcher } from '../src/bot/dispatcher.js';

// a fake api that records timestamps and can be told to throttle
function fakeApi({ throttleAfter = Infinity, retryAfter = 3 } = {}) {
  const calls = [];
  let sendCount = 0;
  return {
    calls,
    async sendMessage(chatId, text) {
      sendCount++;
      if (sendCount === throttleAfter) {
        const e = new Error('Too Many Requests: retry after ' + retryAfter);
        e.parameters = { retry_after: retryAfter };
        throw e;
      }
      calls.push({ t: Date.now(), chatId });
      return { message_id: calls.length };
    },
    async editMessageText(chatId, msgId, text) {
      calls.push({ t: Date.now(), chatId });
      return { message_id: msgId };
    },
  };
}

function rate(calls) {
  // requests per second measured across the whole burst
  const span = (calls.at(-1).t - calls[0].t) / 1000;
  return calls.length / (span || 1);
}

test('a burst stays under the global rate limit', async () => {
  const api = fakeApi();
  const d = new TelegramDispatcher(api, { globalRps: 10, perChatDelayMs: 0 });
  const n = 30;
  await Promise.all(Array.from({ length: n }, (_, i) => d.send(1, `m${i}`)));
  const rps = rate(api.calls);
  assert.ok(api.calls.length === n, `sent ${api.calls.length} of ${n}`);
  assert.ok(rps <= 11, `global rate exceeded: ${rps.toFixed(1)} rps`);
});

test('per-chat delay holds even across a burst', async () => {
  const api = fakeApi();
  const d = new TelegramDispatcher(api, { globalRps: 100, perChatDelayMs: 100 });
  await Promise.all(Array.from({ length: 6 }, (_, i) => d.send(42, `m${i}`)));
  for (let i = 1; i < api.calls.length; i++) {
    const gap = api.calls[i].t - api.calls[i - 1].t;
    assert.ok(gap >= 95, `per-chat gap too small: ${gap}ms`);
  }
});

test('different chats are not serialized by each other', async () => {
  const api = fakeApi();
  const d = new TelegramDispatcher(api, { globalRps: 100, perChatDelayMs: 200 });
  const start = Date.now();
  await Promise.all([
    d.send(100, 'a'),
    d.send(200, 'b'),
    d.send(300, 'c'),
  ]);
  const span = Date.now() - start;
  // 3 chats at 200ms per-chat delay would take 400ms+ if serialized; in
  // parallel they finish in roughly one delay
  assert.ok(span < 350, `chats serialized: ${span}ms`);
});

test('a 429 backs off and the message still lands', async () => {
  const api = fakeApi({ throttleAfter: 2, retryAfter: 1 });
  const d = new TelegramDispatcher(api, { globalRps: 100, perChatDelayMs: 0 });
  const results = await Promise.allSettled([
    d.send(7, 'first'),
    d.send(7, 'second'),
    d.send(7, 'third'),
  ]);
  assert.ok(results.every((r) => r.status === 'fulfilled'), 'a 429 dropped a message instead of retrying');
  assert.equal(api.calls.length, 3, 'all sends eventually landed');
});

test('a non-429 error rejects the caller', async () => {
  const api = {
    async sendMessage() { const e = new Error('chat not found'); throw e; },
    async editMessageText() { throw new Error('no'); },
  };
  const d = new TelegramDispatcher(api);
  await assert.rejects(() => d.send(9, 'x'), /chat not found/);
});

test('health: stats report throughput', async () => {
  const api = fakeApi();
  const d = new TelegramDispatcher(api, { globalRps: 50, perChatDelayMs: 0 });
  await d.send(1, 'a');
  const s = d.stats();
  assert.ok(s.sent >= 1, 'sent count missing');
});
