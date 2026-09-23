// language: JavaScript (Node 20+ ESM), file: src/proxy/pool.js
// Proxy dispatcher cache + per-chat proxy selection.
//
// Hardening (v2):
// - rejectUnauthorized is TRUE on every proxy TLS hop. The old false disabled
//   certificate validation entirely, so a hostile proxy could MITM every
//   request and read the Authorization header with the model API key in it.
// - The agent cache is BOUNDED (LRU, default 256). A plain Map on a 10k pool
//   holds thousands of ProxyAgent instances open — each one pins sockets and
//   file descriptors until the process hits fd exhaustion / OOM. An evicted
//   entry is destroyed so its sockets actually close.
// - chatProxyIndex has a TTL so a chat's proxy binding does not outlive a
//   dead proxy by 30 minutes of cached silence.

import { ProxyAgent } from 'undici';
import { pickRandomProxy, pickProxyForChat, proxyOk, proxyFail, proxyStats } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { healthRegistry } from './health.js';

const MAX_AGENTS = Math.max(8, intOr(config?.proxy?.maxLruAgents, 256));
const CHAT_TTL_MS = 30 * 60 * 1000;

function intOr(v, dflt) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/**
 * Bounded LRU cache of ProxyAgent instances. get() refreshes lastUsed; when the
 * capacity is reached the least recently used (or an expired) entry is evicted
 * and its dispatcher destroyed so sockets are released, not leaked.
 */
class BoundedAgentCache {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.cache = new Map(); // url -> { agent, lastUsed }
  }

  get(url) {
    const entry = this.cache.get(url);
    if (!entry) return null;
    entry.lastUsed = Date.now();
    return entry.agent;
  }

  set(url, agent) {
    if (this.cache.size >= this.maxSize && !this.cache.has(url)) {
      this.evictOne();
    }
    this.cache.set(url, { agent, lastUsed: Date.now() });
  }

  evictOne() {
    let oldestKey = null;
    let oldestTime = Infinity;
    const now = Date.now();
    for (const [key, val] of this.cache.entries()) {
      // expired entries are evicted first; otherwise the least recently used
      if (now - val.lastUsed > CHAT_TTL_MS || val.lastUsed < oldestTime) {
        oldestTime = val.lastUsed;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      const evicted = this.cache.get(oldestKey);
      try { evicted.agent.destroy(); } catch { /* already closed */ }
      this.cache.delete(oldestKey);
      logger.debug({ evicted: oldestKey, size: this.cache.size }, 'proxy agent evicted (LRU)');
    }
  }

  destroyAll() {
    for (const val of this.cache.values()) {
      try { val.agent.destroy(); } catch { /* already closed */ }
    }
    this.cache.clear();
  }
}

const dispatcherCache = new BoundedAgentCache(MAX_AGENTS);
const chatProxyIndex = new Map(); // chatId -> { proxyId, lastActive }

export function proxyUrl(p) {
  if (!p) return null;
  const auth = p.username
    ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password ?? '')}@`
    : '';
  return `${p.scheme}://${auth}${p.host}:${p.port}`;
}

export function dispatcherForProxy(p) {
  if (!p) return null;
  const url = proxyUrl(p);
  let agent = dispatcherCache.get(url);
  if (!agent) {
    agent = new ProxyAgent({
      uri: url,
      // MUST stay true: without certificate validation, any proxy in the pool
      // can read the Authorization header off the proxied request.
      requestTls: { rejectUnauthorized: true },
      connect: { timeout: 10_000 },
    });
    dispatcherCache.set(url, agent);
  }
  return agent;
}

export function getRandomProxy() {
  return pickRandomProxy();
}
export function getChatProxy(chatId) {
  // Stable binding per chat, refreshed while live. The TTL only controls when a
  // silent index entry is re-picked — the db pick itself is what keeps working
  // proxies sticky, and this returns the proxy either way, as every caller
  // (providers/client.js) already expects a proxy object or null.
  const p = pickProxyForChat(chatId);
  if (p) chatProxyIndex.set(chatId, { proxyId: p.id, lastActive: Date.now() });
  return p;
}
export function markOk(id) {
  if (id != null) {
    healthRegistry.markOk(id); // latency-aware weighting
    proxyOk(id);
  }
}
export function markFail(id) {
  if (id != null) {
    const tripped = healthRegistry.markFail(id); // circuit breaker
    proxyFail(id);
    if (tripped) logger.warn({ id }, 'proxy circuit breaker tripped');
  }
}

export function setChatProxyRotation(chatId, proxy) {
  chatProxyIndex.set(chatId, { proxyId: proxy?.id, lastActive: proxy ? Date.now() : 0 });
}
export function rotatedChatProxy(chatId) {
  if (chatProxyIndex.has(chatId)) {
    return null; // caller should not rotate mid-stream
  }
  return pickProxyForChat(chatId);
}

export function proxyStatsLog() {
  return { ...proxyStats(), breaker: healthRegistry.stats() };
}

export async function verifyProxy(p, { timeoutMs = 5000 } = {}) {
  const dispatcher = dispatcherForProxy(p);
  if (!dispatcher) return false;
  // socks4 cannot carry the TLS CONNECT the liveness probe needs; leave it
  // unchecked rather than crashing the whole sweep
  if (p.scheme === 'socks4') return true;
  const t0 = Date.now();
  try {
    const res = await fetch('https://httpbin.org/ip', {
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) { markFail(p.id); return false; }
    const body = await res.json();
    if (!body?.origin) { markFail(p.id); return false; }
    // a live proxy: record its round-trip for latency-aware routing
    markOk(p.id, Date.now() - t0);
    return true;
  } catch {
    // dead proxy, bad creds, or a non-SOCKS server answering on the port —
    // all surface as a failed TLS probe; just demote it
    markFail(p.id);
    return false;
  }
}

export async function sweepDead({ concurrency = 16, timeoutMs = 4000, maxFails = 5 } = {}) {
  const { db } = await import('../db.js');
  const rows = db.prepare('SELECT * FROM proxies WHERE fails < ? ORDER BY RANDOM() LIMIT 200').all(maxFails);
  let okCount = 0, failCount = 0;
  for (const r of rows) {
    const alive = await verifyProxy(r, { timeoutMs });
    if (alive) { proxyOk(r.id); okCount++; } else { proxyFail(r.id); failCount++; }
  }
  return { checked: rows.length, ok: okCount, fail: failCount };
}

export { BoundedAgentCache };
