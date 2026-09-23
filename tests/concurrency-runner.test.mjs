// language: JavaScript (Node 20+ ESM), file: tests/concurrency-runner.test.mjs
// Acceptance: 50 chats at once must be handled in parallel, and one chat's
// messages must keep FIFO order. A per-chat serialization bug is silent until
// two of a user's replies land out of order in production.

import test from 'node:test';
import assert from 'node:assert/strict';

import { sequentialize } from '../src/bot/runner.js';

/**
 * Drive a middleware chain the way the runner does: every update starts
 * immediately (up to the concurrency ceiling), each runs the chain in order,
 * `next` is what advances it. No hidden ordering — whatever the middleware
 * does with next() is what happens.
 *
 * `step` returns the middleware's promise, because sequentialize only delays
 * the next link until its chain settles — if the promise the handler returns
 * is dropped, the chain settles early and the chat's messages race.
 */
async function runUpdates(middlewares, updates, { concurrency = 50 } = {}) {
  const indexPerUpdate = new Map();
  let inflight = 0;
  let finished = 0;
  const total = updates.length;

  const step = (ctx) => {
    const i = indexPerUpdate.get(ctx);
    if (i >= middlewares.length) return Promise.resolve();
    indexPerUpdate.set(ctx, i + 1);
    return middlewares[i](ctx, () => step(ctx));
  };

  const start = (ctx) => {
    indexPerUpdate.set(ctx, 0);
    inflight++;
    return step(ctx).then(() => {
      inflight--;
      finished++;
      // a slot freed — start anything still waiting
      while (updates.length && inflight < concurrency) start(updates.shift());
    });
  };

  const all = new Promise((resolve) => {
    const check = () => (finished === total ? resolve() : setTimeout(check, 10));
    check();
  });

  while (updates.length && inflight < concurrency) start(updates.shift());
  await all;
}

test('updates from different chats run in parallel', async () => {
  const mw = [sequentialize((ctx) => ctx.chat?.id && String(ctx.chat.id))];
  const started = [];
  mw.push(async (ctx, next) => {
    started.push(ctx.chat.id);
    await new Promise((res) => setTimeout(res, 40));
    return next();
  });

  const updates = Array.from({ length: 50 }, (_, i) => ({ chat: { id: 1000 + i } }));
  const t0 = Date.now();
  await runUpdates(mw, updates);
  const ms = Date.now() - t0;

  assert.equal(started.length, 50, 'not every update started');
  // 50 × 40ms = 2s if serialized; overlapping they finish in well under that
  assert.ok(ms < 2000, `updates were serialized: ${ms}ms for 50 parallel chats`);
});

test('updates from one chat keep FIFO order', async () => {
  const mw = [sequentialize((ctx) => ctx.chat?.id && String(ctx.chat.id))];
  const order = [];
  // sleep longer for earlier messages, so a race would visibly scramble the order
  mw.push(async (ctx, next) => {
    await new Promise((res) => setTimeout(res, 60 - (ctx.msg % 5) * 10));
    order.push({ chat: ctx.chat.id, msg: ctx.msg });
    return next();
  });

  // interleaved with another chat so the runner is free to race them
  const updates = [];
  for (let i = 0; i < 10; i++) {
    updates.push({ chat: { id: 5 }, msg: i });
    updates.push({ chat: { id: 6 }, msg: i });
  }
  await runUpdates(mw, updates);

  const chat5 = order.filter((m) => m.chat === 5).map((m) => m.msg);
  assert.deepEqual(chat5, Array.from({ length: 10 }, (_, i) => i), 'per-chat order broke');
});

test('a chat key of undefined is never serialized', async () => {
  const mw = [sequentialize((ctx) => ctx.chat?.id && String(ctx.chat.id))];
  const order = [];
  mw.push(async (ctx, next) => { order.push(ctx.msg); return next(); });

  // no chat field → undefined key → run immediately, in arrival order
  await runUpdates(mw, [{ msg: 'a' }, { msg: 'b' }, { msg: 'c' }]);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('20 parallel chats, 5 messages each: every chat stays ordered', async () => {
  const mw = [sequentialize((ctx) => ctx.chat?.id && String(ctx.chat.id))];
  const order = [];
  mw.push(async (ctx, next) => {
    await new Promise((res) => setTimeout(res, (ctx.msg % 7) * 5));
    order.push({ chat: ctx.chat.id, msg: ctx.msg });
    return next();
  });

  const updates = [];
  for (let m = 0; m < 5; m++) {
    for (let c = 0; c < 20; c++) updates.push({ chat: { id: 2000 + c }, msg: m });
    // shuffle only across chats — within a chat, arrival order must stay 0..4,
    // because that is the order sequentialize is contracted to preserve
    const start = updates.length - 20;
    for (let i = updates.length - 1; i > start; i--) {
      const j = start + Math.floor(Math.random() * (i - start + 1));
      [updates[i], updates[j]] = [updates[j], updates[i]];
    }
  }

  await runUpdates(mw, updates, { concurrency: 20 });
  assert.equal(order.length, 100, 'updates were lost');

  for (let c = 0; c < 20; c++) {
    const seq = order.filter((m) => m.chat === 2000 + c).map((m) => m.msg);
    assert.deepEqual(seq, [0, 1, 2, 3, 4], `chat ${2000 + c} order broke: ${JSON.stringify(seq)}`);
  }
});
