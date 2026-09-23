// language: JavaScript (Node 20+ ESM), file: src/cache/index.js
// Optional L2 (Redis/KeyDB) distributed state.
//
// Single-node is the target deployment, so Redis is NOT required. When
// REDIS_URL is absent this resolves to the in-memory fallback and the whole
// gateway runs on L1 alone — nothing in the call path waits for a socket.
//
// The surface stays tiny and shaped like a real L2 (get/set/del + a distributed
// lock) so a multi-node deploy can add REDIS_URL and get cross-instance state
// without a refactor of the call sites.

import { config } from '../config.js';
import { logger } from '../logger.js';
import { LruCache } from './l1.js';

let _client = null;
let _redisUrl = null;
let _connected = false;
const _fallback = new LruCache({ max: 4096, ttlMs: 0 });
const _locks = new Map();

/**
 * Lazily create the ioredis client on first use, not at import time. An absent
 * or unreachable Redis must never stop the bot from starting.
 *
 * @returns {Promise<null|object>} the client, or null when Redis is not configured
 */
async function client() {
  const url = config?.cache?.redisUrl || process.env.REDIS_URL || '';
  if (!url) return null;
  if (_client) return _connected ? _client : null;

  try {
    // dynamic import: ioredis is an optional dependency, not a hard one
    const { default: Redis } = await import('ioredis');
    _redisUrl = url;
    _client = new Redis(url, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    _client.on('error', (err) => logger.warn({ err: err.message }, 'redis error (operating on L1 fallback)'));
    await _client.connect();
    _connected = true;
    logger.info({ redis: true }, 'L2 cache connected');
    return _client;
  } catch (err) {
    logger.warn({ err: err.message }, 'L2 unavailable — using in-memory fallback');
    _connected = false;
    return null;
  }
}

export async function l2Get(key) {
  const c = await client();
  if (!c) return _fallback.get(key);
  try {
    const raw = await c.get(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch (err) {
    logger.debug({ err: err.message, key }, 'l2 get failed → fallback');
    return _fallback.get(key);
  }
}

export async function l2Set(key, value, ttlSeconds = 0) {
  const c = await client();
  if (!c) { _fallback.set(key, value); return; }
  try {
    if (ttlSeconds > 0) await c.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    else await c.set(key, JSON.stringify(value));
  } catch (err) {
    logger.debug({ err: err.message, key }, 'l2 set failed → fallback');
    _fallback.set(key, value);
  }
}

export async function l2Del(key) {
  const c = await client();
  if (!c) { _fallback.del(key); return; }
  try { await c.del(key); } catch { /* best effort */ }
}

/**
 * Try-and-set lock. In single-node mode this is backed by a local Map — enough
 * to serialize two racing turns for one chat in one process. With Redis it
 * becomes a cross-instance lock for the multi-node case.
 *
 * The TTL guarantees the lock releases even if the holder dies mid-turn.
 *
 * @param {string} key lock name
 * @param {number} ttlMs
 * @returns {Promise<() => void>} release function; call exactly once
 */
export async function acquireLock(key, ttlMs = 60_000) {
  const c = await client();
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

  if (!c) {
    const held = _locks.get(key);
    if (held && Date.now() < held.expire) return () => {}; // already held: no-op release
    _locks.set(key, { token, expire: Date.now() + ttlMs });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const cur = _locks.get(key);
      if (cur?.token === token) _locks.delete(key);
    };
  }

  try {
    const ok = await c.set(key, token, 'PX', ttlMs, 'NX');
    if (!ok) return () => {};
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // release only if we still own it — a Lua script makes the check+del atomic
      c.eval(
        'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
        1, key, token,
      ).catch(() => {});
    };
  } catch {
    return () => {};
  }
}

/** True when an L2 is actually connected (observability only). */
export function l2Status() {
  return { connected: _connected, url: _redisUrl ? 'set' : 'unset' };
}
