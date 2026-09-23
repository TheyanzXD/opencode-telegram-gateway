// language: JavaScript (Node 20+ ESM), file: src/bot/dispatcher.js
// Outbound Telegram dispatcher with strict flood control.
//
// Telegram's limits, all of which end in 429 when broken:
//   30 msg/sec globally for the bot
//    1 msg/sec per chat
//   20 msg/min per group
//
// Every outbound send and edit goes through here instead of calling the API
// directly. The queue is prioritized, a global limiter keeps the bot under the
// overall ceiling, and a per-chat limiter enforces the per-chat pace. A 429 is
// not an error here — it is a signal: the job goes back to the head of the
// queue and the chat's limiter is paused for retry_after, so nothing is dropped
// and order is preserved.
//
// Single-node: the queue is in-process, which is enough for one bot instance.

import { logger } from '../logger.js';

const PRIORITY = {
  CALLBACK: 1, // callback_query answers — the user is staring at the screen
  DM: 2,       // direct messages
  GROUP: 3,    // group + broadcast
};

/**
 * Per-chat pacer: a strict minimum gap between two sends to the same chat.
 * A token-bucket with capacity 1 allows a burst of two back-to-back sends
 * whenever the refill happens to land mid-gap — one request spends the token,
 * the next arrives after a partial refill and waits only the remainder. For a
 * hard floor that is wrong: Telegram's per-chat limit is a pace, not a budget.
 * So the first send also pays.
 */
class ChatPacer {
  constructor({ delayMs }) {
    this.delay = delayMs;
    this.readyAt = 0;
  }

  /** ms the caller must wait, and reserve the slot. */
  waitMs() {
    const now = Date.now();
    const wait = Math.max(0, this.readyAt - now);
    this.readyAt = now + wait + this.delay;
    return wait;
  }

  /** Park after a 429: nothing leaves until untilMs. */
  parkUntil(untilMs) {
    this.readyAt = Math.max(this.readyAt, untilMs);
  }
}

/**
 * Leaky-bucket-ish rate limiter for the global ceiling: a request costs one
 * token, tokens refill at a fixed rate, and a request that would exceed the
 * capacity waits for the next token. Time-based, so it never bursts over the
 * ceiling on a fresh start.
 */
class RateLimiter {
  constructor({ ratePerSec, capacity }) {
    this.rate = ratePerSec / 1000; // tokens per ms
    this.capacity = capacity;
    this.tokens = capacity; // start full: the first requests go straight out
    this.lastRefill = Date.now();
  }

  /** ms the caller must wait before one token is available. */
  waitMs() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
    this.lastRefill = now;
    if (this.tokens >= 1) { this.tokens -= 1; return 0; }
    // time until the next whole token
    const need = 1 - this.tokens;
    return Math.ceil(need / this.rate);
  }

  /** Park the limiter (after a 429): no token may be spent before untilMs. */
  parkUntil(untilMs) {
    this.lastRefill = Math.max(this.lastRefill, untilMs);
    this.tokens = 0;
  }
}

export class TelegramDispatcher {
  /**
   * @param {object} api grammY bot.api (or a telegraf bot.telegram handle)
   * @param {object} [opts]
   * @param {number} [opts.globalRps=28] global ceiling, below Telegram's 30
   * @param {number} [opts.perChatDelayMs=1050] min gap between sends to one chat
   */
  constructor(api, opts = {}) {
    this.api = api;
    this.global = new RateLimiter({ ratePerSec: opts.globalRps || 28, capacity: opts.globalRps || 28 });
    this.perChatDelayMs = opts.perChatDelayMs || 1050;
    this.chatLimiters = new Map(); // chatId -> ChatPacer (hard per-chat floor)
    this.chatPausedUntil = new Map(); // chatId -> epoch ms (429 backoff)
    this.queue = []; // { type, chatId, priority, seq }
    this.isProcessing = false;
    this.seq = 0;
    this.sent = 0;
    this.throttled = 0;
  }

  #chatLimiter(chatId) {
    let lim = this.chatLimiters.get(chatId);
    if (!lim) {
      lim = new ChatPacer({ delayMs: this.perChatDelayMs });
      this.chatLimiters.set(chatId, lim);
    }
    return lim;
  }

  #enqueue(job) {
    // stable priority: lower priority number first, then insertion order, so
    // two DMs to one chat can never overtake each other
    job.seq = this.seq++;
    const i = this.queue.findIndex((j) => j.priority > job.priority || (j.priority === job.priority && j.seq > job.seq));
    if (i < 0) this.queue.push(job);
    else this.queue.splice(i, 0, job);
    this.#process();
  }

  send(chatId, text, options = {}, priority = PRIORITY.DM) {
    return new Promise((resolve, reject) => {
      this.#enqueue({ type: 'send', chatId, text, options, priority, resolve, reject });
    });
  }

  edit(chatId, messageId, text, options = {}, priority = PRIORITY.DM) {
    return new Promise((resolve, reject) => {
      this.#enqueue({ type: 'edit', chatId, messageId, text, options, priority, resolve, reject });
    });
  }

  /** A callback answer is already answered by grammY; this is for the keyboard itself. */
  sendCallback(chatId, text, options = {}) {
    return this.send(chatId, text, options, PRIORITY.CALLBACK);
  }

  async #process() {
    if (this.isProcessing || !this.queue.length) return;
    this.isProcessing = true;

    try {
      while (this.queue.length) {
        // a paused chat stays queued — skip it and come back when its window opens
        const item = this.queue.find((j) => Date.now() >= (this.chatPausedUntil.get(j.chatId) || 0));
        if (!item) {
          // everything left is parked behind a 429. Sleep until the earliest
          // window opens instead of spinning — a busy find-loop at 100% CPU is
          // worse than a wait, and the loop exits otherwise.
          const next = Math.min(...[...this.chatPausedUntil.values()].filter((u) => u > Date.now()));
          if (Number.isFinite(next)) {
            await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(0, next - Date.now() + 50))));
            continue;
          }
          break;
        }

        const i = this.queue.indexOf(item);
        this.queue.splice(i, 1);

        const now = Date.now();
        const gWait = this.global.waitMs();
        const cWait = this.#chatLimiter(item.chatId).waitMs();
        const wait = Math.max(gWait, cWait);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));

        try {
          let res;
          if (item.type === 'send') {
            res = await this.api.sendMessage(item.chatId, item.text, item.options);
          } else if (item.type === 'edit') {
            res = await this.api.editMessageText(item.chatId, item.messageId, item.text, item.options);
          }
          item.resolve(res);
          this.sent++;
        } catch (err) {
          const retryAfter = err?.parameters?.retry_after || err?.error_code === 429
            ? this.#extractRetryAfter(err)
            : null;
          if (retryAfter) {
            this.throttled++;
            // Telegram says when this chat may send again. Park the chat and put
            // the job back at the HEAD — order is preserved, nothing is lost.
            const until = Date.now() + (retryAfter + 1) * 1000;
            this.chatPausedUntil.set(item.chatId, until);
            this.#chatLimiter(item.chatId).parkUntil(until);
            logger.warn({ chatId: item.chatId, retryAfter }, 'flood control — re-queueing at head');
            this.queue.unshift(item);
            // sleep to the window instead of busy-looping the queue
            await new Promise((r) => setTimeout(r, until - Date.now() + 100));
          } else {
            item.reject(err);
          }
        }
      }
    } finally {
      this.isProcessing = false;
      if (this.queue.length) this.#process(); // a paused chat may have opened up
    }
  }

  #extractRetryAfter(err) {
    const raw = err?.parameters?.retry_after;
    if (Number.isFinite(raw)) return raw;
    const m = String(err?.message || '').match(/retry after (\d+)/i);
    return m ? parseInt(m[1], 10) : 1;
  }

  /** Snapshot for /debug. */
  stats() {
    return {
      queueDepth: this.queue.length,
      chatsTracked: this.chatLimiters.size,
      sent: this.sent,
      throttled: this.throttled,
      pausedChats: [...this.chatPausedUntil.values()].filter((u) => u > Date.now()).length,
    };
  }
}

export { PRIORITY };
