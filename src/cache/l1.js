// language: JavaScript (Node 20+ ESM), file: src/cache/l1.js
// L1 in-memory LRU cache for hot, read-heavy, rarely-changing state: user
// config rows, active model picks, daily quota counters.
//
// A user row is read on every single inbound message (auth + model resolution)
// and written only on /model or /system. Hitting SQLite for it each time is
// pure syscall overhead — this keeps the hot path under a microsecond.
//
// L2 (Redis/KeyDB) is optional and NOT required by anything here: single-node
// is the target. The interface below is shaped so an L2 can be slotted in later
// (get/set/del with a serializer) without touching call sites.

/**
 * LRU cache. Map preserves insertion order, and a re-set of an existing key
 * moves it to the end — so delete-the-oldest on overflow is true LRU.
 */
export class LruCache {
  /**
   * @param {object} opts
   * @param {number} opts.max entries before the least recently used is evicted
   * @param {number} [opts.ttlMs] optional entry expiry; 0 = no expiry
   */
  constructor({ max = 512, ttlMs = 0 } = {}) {
    this.max = Math.max(1, max);
    this.ttlMs = Math.max(0, ttlMs || 0);
    this.store = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  /** @returns {boolean} true when a TTL is set and the entry aged out */
  #stale(entry) {
    return this.ttlMs > 0 && Date.now() - entry.ts > this.ttlMs;
  }

  has(key) {
    const entry = this.store.get(key);
    if (entry == null) return false;
    if (this.#stale(entry)) { this.store.delete(key); return false; }
    return true;
  }

  get(key) {
    const entry = this.store.get(key);
    if (entry == null) { this.misses++; return undefined; }
    if (this.#stale(entry)) {
      this.store.delete(key);
      this.misses++;
      return undefined;
    }
    // refresh position so this key is now the most recently used
    this.store.delete(key);
    this.store.set(key, entry);
    this.hits++;
    return entry.v;
  }

  set(key, value) {
    if (this.store.has(key)) this.store.delete(key);
    else if (this.store.size >= this.max) {
      // oldest key is the first one — Map iterates in insertion order
      const oldest = this.store.keys().next().value;
      this.store.delete(oldest);
    }
    this.store.set(key, { v: value, ts: Date.now() });
    return value;
  }

  del(key) {
    return this.store.delete(key);
  }

  clear() {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /** Hit ratio for observability — a low ratio means the cache is mis-sized. */
  stats() {
    const total = this.hits + this.misses;
    return { size: this.store.size, hits: this.hits, misses: this.misses, ratio: total ? this.hits / total : 0 };
  }
}

// Per-user config row: read on every message, written only on a /model or
// /system change. TTL guards a stale row after an admin edits the db directly.
export const userConfigCache = new LruCache({ max: 1024, ttlMs: 60_000 });

// Daily quota counters: incremented per turn and reset on rollover. Small and
// extremely hot.
export const quotaCache = new LruCache({ max: 2048, ttlMs: 0 });
