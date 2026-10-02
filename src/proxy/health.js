// language: JavaScript (Node 20+ ESM), file: src/proxy/health.js
// Proxy health pipeline: circuit breaker + latency scoring.
//
// A pool of thousands of open proxies is mostly dead at any moment. Marking a
// proxy failed once is not enough — the breaker trips after repeated failures
// and takes the proxy OUT of rotation for a cooldown, so a permanently dead
// entry stops being picked and retested every single turn.
//
// Latency scoring feeds a weighted pick: the fastest proxies win
// proportionally more chats, instead of RANDOM() handing a chat to a 5-second
// proxy that then times out mid-stream.

const FAIL_THRESHOLD = 3;     // failures inside the window → TRIPPED
const WINDOW_MS = 2 * 60_000; // 2-minute rolling window
const COOLDOWN_MS = 15 * 60_000; // a tripped proxy sits out for 15 min
const P_MAX = 100;            // latency samples kept per proxy

/**
 * One proxy's health state. fail timestamps are a ring buffer so memory is
 * bounded even for a 10k pool.
 */
class ProxyHealth {
  constructor(id) {
    this.id = id;
    this.fails = [];      // timestamps of recent failures (ring)
    this.latencies = [];  // last P_MAX round-trip samples in ms
    this.trippedAt = 0;   // epoch ms; 0 = not tripped
  }

  /** Failures inside the rolling window only — old ones do not count. */
  #recentFails(now) {
    return this.fails.filter((t) => now - t < WINDOW_MS);
  }

  isTripped(now = Date.now()) {
    if (!this.trippedAt) return false;
    if (now - this.trippedAt >= COOLDOWN_MS) {
      // cooldown over: reset and give it one chance to prove itself
      this.trippedAt = 0;
      this.fails = [];
      return false;
    }
    return true;
  }

  recordFail(now = Date.now()) {
    this.fails.push(now);
    if (this.fails.length > FAIL_THRESHOLD * 2) this.fails.shift();
    if (this.#recentFails(now).length >= FAIL_THRESHOLD) {
      this.trippedAt = now;
      return true; // newly tripped
    }
    return false;
  }

  recordSuccess(latencyMs = 0) {
    this.latencies.push(Math.max(0, Math.min(60_000, latencyMs)));
    if (this.latencies.length > P_MAX) this.latencies.shift();
  }

  /** p90 latency in ms; undefined when we have no samples yet. */
  p90() {
    if (!this.latencies.length) return undefined;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9));
    return sorted[idx];
  }
}

/**
 * In-process circuit-breaker registry. Bounded by the number of proxies that
 * have ever failed; entries for healthy proxies are never created.
 */
export class HealthRegistry {
  constructor() {
    this.map = new Map();
  }

  #get(id) {
    let h = this.map.get(id);
    if (!h) { h = new ProxyHealth(id); this.map.set(id, h); }
    return h;
  }

  /** True when this proxy should NOT be used right now. */
  isTripped(id) {
    const h = this.map.get(id);
    return h ? h.isTripped() : false;
  }

  markFail(id) {
    if (id == null) return false;
    return this.#get(id).recordFail();
  }

  markOk(id, latencyMs) {
    if (id == null) return;
    this.#get(id).recordSuccess(latencyMs);
  }

  p90(id) {
    const h = this.map.get(id);
    return h ? h.p90() : undefined;
  }

  /**
   * Weighted pick over healthy candidates. Weight = 1 / (p90_ms + floor), so a
   * faster proxy is preferred but a slow one is never fully starved — a
   * currently-fast proxy can degrade, and zero-weighting it means it would
   * never be tested again.
   *
   * @param {Array<{id:number}>} candidates healthy proxies from the db
   * @returns {object|null} one candidate, weighted toward the fastest
   */
  weightedPick(candidates) {
    if (!candidates?.length) return null;
    const usable = candidates.filter((c) => !this.isTripped(c.id));
    if (!usable.length) return null;

    const weights = usable.map((c) => {
      const p = this.p90(c.id);
      // no samples yet → neutral weight, so a new proxy gets a fair first pick
      return p == null ? 1 : 1000 / (p + 200);
    });
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < usable.length; i++) {
      r -= weights[i];
      if (r <= 0) return usable[i];
    }
    return usable[usable.length - 1];
  }

  /** Snapshot for the /proxy admin view. */
  stats() {
    let tripped = 0;
    const latencies = [];
    for (const h of this.map.values()) {
      if (h.isTripped()) tripped++;
      const p = h.p90();
      if (p != null) latencies.push(p);
    }
    latencies.sort((a, b) => a - b);
    return {
      tracked: this.map.size,
      tripped,
      medianP90: latencies.length ? latencies[Math.floor(latencies.length / 2)] : undefined,
    };
  }
}

export const healthRegistry = new HealthRegistry();
export { ProxyHealth };
