// language: JavaScript (Node 20+ ESM), file: src/bot/features/webhooks.js
// Outbound webhooks: notify external systems about gateway events.
//
// The bot could only talk to Telegram. An operator who wants a Slack ping on a
// quota alert, or a metrics system that scrapes events, had no hook. This
// module is the outbound side: it fires on lifecycle events with retries and
// an exponential backoff, and one failing subscriber never blocks another.

import { fetch } from 'undici';
import { logger } from '../../logger.js';

/** @type {Array<{url, secret, events}>} */
let _subs = [];

const MAX_ATTEMPTS = 4;
const RETRY_MS = [2_000, 8_000, 30_000];

/**
 * Load subscribers from a JSON array. Kept as a plain config value so a reload
 * (SIGHUP) picks up new endpoints without a restart.
 *
 * @param {string} json [{"url":"https://hook","secret":"...","events":["*"]}]
 */
export function loadSubscribers(json) {
  let list = [];
  try { list = JSON.parse(json || '[]'); } catch (err) {
    logger.warn({ err: err.message }, 'WEBHOOK_SUBSCRIBERS is not valid JSON');
  }
  _subs = list.filter((s) => s && s.url);
}

/** True when at least one subscriber wants this event type. */
export function hasSubscribers(event) {
  return _subs.some((s) => s.events?.includes('*') || s.events?.includes(event));
}

function sign(body, secret) {
  // HMAC-SHA256 in hex — the subscriber verifies with the shared secret.
  if (!secret || !globalThis.crypto?.subtle) return undefined;
  return globalThis.crypto.subtle
    .importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    .then((k) => globalThis.crypto.subtle.sign('HMAC', k, new TextEncoder().encode(body)))
    .then((sig) => Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join(''));
}

/**
 * Fire an event to every interested subscriber. Never throws — a broken
 * subscriber is logged, not propagated, so the turn that triggered it still
 * completes.
 *
 * @param {string} event  e.g. 'quota.reached', 'agent.turn.done', 'dlq.pushed'
 * @param {object} payload  must be JSON-serializable
 */
export async function emit(event, payload = {}) {
  if (!_subs.length) return;
  const body = JSON.stringify({ event, at: new Date().toISOString(), data: redactPayload(payload) });
  const interested = _subs.filter((s) => s.events?.includes('*') || s.events?.includes(event));
  await Promise.allSettled(interested.map((s) => deliver(s, event, body)));
}

async function deliver(sub, event, body) {
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      const sig = await sign(body, sub.secret);
      const res = await fetch(sub.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Gateway-Event': event,
          ...(sig ? { 'X-Gateway-Signature': 'sha256=' + sig } : {}),
        },
        body,
      });
      if (res.ok) return;
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        logger.warn({ url: sub.url, status: res.status, event }, 'webhook subscriber rejected — not retrying');
        return;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) {
        logger.warn({ url: sub.url, event, err: err.message }, 'webhook delivery failed after retries');
        return;
      }
      const delay = RETRY_MS[Math.min(attempt - 1, RETRY_MS.length - 1)];
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// Subscribers may log the payload server-side; strip anything credential-shaped
// before it leaves the process.
function redactPayload(p) {
  const KEYS = ['api_key', 'apikey', 'token', 'secret', 'authorization', 'password', 'key'];
  if (!p || typeof p !== 'object') return p;
  const out = Array.isArray(p) ? [...p] : { ...p };
  for (const [k, v] of Object.entries(out)) {
    if (KEYS.includes(k.toLowerCase())) out[k] = '***';
    else if (v && typeof v === 'object') out[k] = redactPayload(v);
  }
  return out;
}

export function subscriberCount() { return _subs.length; }
