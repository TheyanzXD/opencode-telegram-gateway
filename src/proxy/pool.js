import { ProxyAgent } from 'undici';
import { pickRandomProxy, pickProxyForChat, proxyOk, proxyFail, proxyStats } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const cache = new Map(); // dispatcher key -> ProxyAgent
let chatProxyIndex = new Map(); // chatId -> proxyId

export function dispatcherForProxy(p) {
  if (!p) return null;
  const url = `${p.scheme}://${p.host}:${p.port}`;
  let agent = cache.get(url);
  if (!agent) {
    agent = new ProxyAgent({ uri: url, requestTls: { rejectUnauthorized: false } });
    cache.set(url, agent);
  }
  return agent;
}

export function getRandomProxy() {
  return pickRandomProxy();
}
export function getChatProxy(chatId) {
  return pickProxyForChat(chatId);
}
export function markOk(id) { if (id != null) proxyOk(id); }
export function markFail(id) { if (id != null) proxyFail(id); }

export function setChatProxyRotation(chatId, proxy) {
  chatProxyIndex.set(chatId, proxy?.id);
}
export function rotatedChatProxy(chatId) {
  if (chatProxyIndex.has(chatId)) {
    return null; // caller should not rotate mid-stream
  }
  return pickProxyForChat(chatId);
}

export function proxyStatsLog() {
  return proxyStats();
}

export async function verifyProxy(p, { timeoutMs = 5000 } = {}) {
  const dispatcher = dispatcherForProxy(p);
  if (!dispatcher) return false;
  try {
    const res = await fetch('https://httpbin.org/ip', {
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return Boolean(body?.origin);
  } catch {
    return false;
  }
}

export async function sweepDead({ concurrency = 16, timeoutMs = 4000, maxFails = 5 } = {}) {
  const { default: Database } = await import('better-sqlite3');
  const { db } = await import('../db.js');
  const rows = db.prepare('SELECT * FROM proxies WHERE fails < ? ORDER BY RANDOM() LIMIT 200').all(maxFails);
  let okCount = 0, failCount = 0;
  for (const r of rows) {
    const alive = await verifyProxy(r, { timeoutMs });
    if (alive) { proxyOk(r.id); okCount++; } else { proxyFail(r.id); failCount++; }
  }
  return { checked: rows.length, ok: okCount, fail: failCount };
}
