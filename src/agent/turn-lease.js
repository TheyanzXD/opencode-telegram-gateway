// language: JavaScript (Node 20+ ESM), file: src/agent/turn-lease.js
// One in-flight turn per chat. A second message while the first is still
// streaming would interleave two answers into the same chat window and send the
// history out of sync — message N+1 would read a history that does not yet
// contain message N's reply.
//
// A lease is a token: taken before a turn, released when the turn finishes or
// fails. Queueing is intentional — a fast double-send should not be dropped, the
// second message should wait and then run against the now-complete history.
//
// Cross-process this is not; a second process would need a file or advisory lock.
// Same-process racing is the failure mode this gateway actually has.

import { logger } from '../logger.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // a turn older than this is abandoned
const DEFAULT_QUEUE_MS = 30_000;           // give up waiting after this long

export class TurnLease {
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS, queueMs = DEFAULT_QUEUE_MS } = {}) {
    /** @type {Map<string, {takenAt: number, release: Function}>} */
    this.leases = new Map();
    /** @type {Map<string, Array<{resolve, reject, timeout}>>} */
    this.waiters = new Map();
    this.timeoutMs = timeoutMs;
    this.queueMs = queueMs;
  }

  /**
   * Acquire the lease for a chat, or wait for the current holder to release it.
   * @returns {Promise<{ok: boolean, queued: boolean, reason?: string}>}
   */
  async acquire(key) {
    // stale lease: a previous turn crashed without releasing
    const existing = this.leases.get(key);
    if (existing && Date.now() - existing.takenAt > this.timeoutMs) {
      logger.warn({ key }, 'turn lease stale — reclaiming');
      this.release(key, true);
    }

    if (!this.leases.has(key)) {
      this.leases.set(key, { takenAt: Date.now(), release: null });
      return { ok: true, queued: false };
    }

    // someone holds it — wait, up to the queue timeout
    return new Promise((resolve) => {
      const waiters = this.waiters.get(key) || [];
      const timeout = setTimeout(() => {
        const list = this.waiters.get(key) || [];
        const i = list.findIndex((w) => w.resolve === resolve);
        if (i >= 0) list.splice(i, 1);
        resolve({ ok: false, queued: true, reason: 'previous turn is still running — try again in a moment' });
      }, this.queueMs);
      timeout.unref?.();
      waiters.push({ resolve, timeout });
      this.waiters.set(key, waiters);
    });
  }

  /** Release the lease and hand it to the next waiter, if any. */
  release(key, silent = false) {
    const lease = this.leases.get(key);
    if (!lease) return;
    this.leases.delete(key);

    const waiters = this.waiters.get(key);
    const next = waiters?.shift();
    if (!next) return;
    clearTimeout(next.timeout);
    if (!waiters.length) this.waiters.delete(key);
    // hand the lease straight to the waiter
    this.leases.set(key, { takenAt: Date.now(), release: null });
    next.resolve({ ok: true, queued: true });
    if (!silent) logger.debug({ key, queued: this.waiters.get(key)?.length || 0 }, 'lease handed to waiter');
  }

  /** True if a turn is currently in flight for this chat. */
  busy(key) {
    return this.leases.has(key);
  }

  /** Release everything — used on shutdown so no waiter hangs. */
  releaseAll() {
    for (const key of [...this.leases.keys()]) this.release(key, true);
    for (const [, waiters] of this.waiters) {
      for (const w of waiters) { clearTimeout(w.timeout); w.resolve({ ok: false, queued: true, reason: 'shutting down' }); }
    }
    this.waiters.clear();
  }

  stats() {
    return { active: this.leases.size, waiting: [...this.waiters.values()].reduce((n, w) => n + w.length, 0) };
  }
}

/** One shared instance — the gateway is a single process. */
export const turnLease = new TurnLease();

/** grammY middleware: a busy chat gets a typing action, not a hard error. */
export function leaseMiddleware(lease = turnLease) {
  return async (ctx, next) => {
    const key = String(ctx.chat?.id ?? 0);
    if (!key || key === '0') return next();
    if (!lease.busy(key)) return next();
    // let the user know their message is queued rather than silently ignored
    ctx.api.sendChatAction(ctx.chat.id, 'typing').catch(() => {});
    return next();
  };
}

/**
 * Run a turn under the lease. The fn receives nothing; it already holds the lease.
 * Guarantees release on success, error, and abort.
 */
export async function withLease(key, lease, fn) {
  const r = await lease.acquire(key);
  if (!r.ok) throw new Error(r.reason);
  try {
    return await fn();
  } finally {
    lease.release(key);
  }
}
