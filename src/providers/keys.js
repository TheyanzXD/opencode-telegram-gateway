// language: JavaScript (Node 20+ ESM), file: src/providers/keys.js
// Per-user BYO keys + secret redaction + dead letter queue.
//
// BYO: a user pastes their own key once (/key set ...); from then on their
// turns are billed to their own account and they can pick models the operator
// does not offer. Keys are never echoed back and never written to logs.
//
// Redaction: secrets are caught on the way out — in prompts, in tool output,
// in error text. A stack trace that contains an Authorization header is how
// keys leak; this removes them before they reach a log or a chat.
//
// DLQ: a turn that fails after every fallback is not dropped. It is written
// to the dead-letter table with the full request, so the operator can replay
// it once the provider is back instead of asking the user to retype it.

import { db } from '../db.js';
import { logger } from '../logger.js';

db.exec(`CREATE TABLE IF NOT EXISTS user_keys (
  user_id    INTEGER PRIMARY KEY,
  provider   TEXT NOT NULL,
  api_key    TEXT NOT NULL,
  base_url   TEXT,
  models     TEXT,        -- comma-separated allowlist, or empty = inherit
  chain      TEXT,        -- comma-separated provider:model fallback chain
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);`);

db.exec(`CREATE TABLE IF NOT EXISTS dlq (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  chat_id    INTEGER NOT NULL,
  provider   TEXT,
  model      TEXT,
  prompt     TEXT NOT NULL,
  error      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  replayed   INTEGER NOT NULL DEFAULT 0
);`);

// --------------------------------------------------------------- BYO keys

export function setKey(userId, { provider, api_key, base_url, models, chain }) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO user_keys (user_id, provider, api_key, base_url, models, chain, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      provider   = excluded.provider,
      api_key    = excluded.api_key,
      base_url   = excluded.base_url,
      models     = excluded.models,
      chain      = excluded.chain,
      updated_at = excluded.updated_at
  `).run(userId, provider, api_key, base_url || null, models || null, chain || null, now, now);
}

export function getKey(userId) {
  const row = db.prepare('SELECT * FROM user_keys WHERE user_id = ?').get(userId);
  if (!row) return null;
  return {
    ...row,
    models: row.models ? row.models.split(',').map((s) => s.trim()).filter(Boolean) : null,
    chain: row.chain ? row.chain.split(',').map((s) => s.trim()).filter(Boolean) : null,
  };
}

export function clearKey(userId) {
  db.prepare('DELETE FROM user_keys WHERE user_id = ?').run(userId);
}

/**
 * The key the provider client should actually use for this user. Returns null
 * when the user is on the operator's shared key — the existing path.
 */
export function resolvedKeyFor(userId, providerName) {
  const k = getKey(userId);
  if (!k) return null;
  if (providerName && k.provider !== providerName) return null;
  return { api_key: k.api_key, base_url: k.base_url };
}

// --------------------------------------------------------------- redaction

// Ordered longest-first so shorter patterns do not shelter longer ones.
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_\-]{16,}/g,                        // OpenAI / OpenRouter
  /sk-ant-[a-zA-Z0-9_\-]{16,}/g,                   // Anthropic
  /ghp_[a-zA-Z0-9]{30,}/g,                         // GitHub PAT
  /gho_[a-zA-Z0-9]{30,}/g,                         // GitHub OAuth
  /github_pat_[a-zA-Z0-9_]{30,}/g,                 // GitHub fine-grained
  /xox[abprs]-[a-zA-Z0-9\-]{8,}/g,                 // Slack
  /AIza[0-9A-Za-z_\-]{30,}/g,                      // Google
  /eyJ[a-zA-Z0-9_\-]{10,}\.[a-zA-Z0-9_\-]{10,}/g, // JWT
  /(?:user|admin|root):[^\s@:[\]<>"]{4,}@[0-9]{1,3}(?:\.[0-9]{1,3}){3}(:[0-9]+)?/g, // proxy cred
  /\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi,          // MAC
];

const HEADER_HINTS = [
  /authorization\s*[:=]\s*"?[A-Za-z0-9_\-\. ]{6,}/gi,
  /(?:api[_-]?key|x-api-key|access[_-]?token)\s*[:=]\s*"?[A-Za-z0-9_\-\.]{8,}/gi,
];

const MAX_SECRET_LEN = 6;

/**
 * Replace anything that looks like a credential with a marker.
 * Never throws, never returns null — this is the last filter before a string
 * reaches a log line or a chat reply, so a failure here must degrade safe.
 */
export function redact(input, opts = {}) {
  if (input == null) return input;
  if (typeof input !== 'string') {
    if (Array.isArray(input)) return input.map((v) => redact(v, opts));
    if (typeof input === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(input)) out[k] = redact(v, opts);
      return out;
    }
    return input;
  }
  let out = input;
  try {
    for (const re of SECRET_PATTERNS) out = out.replace(re, (m) => mask(m));
    for (const re of HEADER_HINTS) out = out.replace(re, (m) => mask(m));
    if (!opts.keepEnv) out = out.replace(/([A-Z][A-Z0-9_]{4,})=([^\s"'`]+)/g, '$1=***');
  } catch (err) {
    logger.warn({ err: err.message }, 'redaction failed — passing through');
    return input;
  }
  return out;
}

function mask(s) {
  return s.length <= MAX_SECRET_LEN ? '***' : s.slice(0, 3) + '***' + s.slice(-2);
}

/**
 * True when a string carries something that must never leave the process.
 * Use it as a gate before writing a prompt or an error to the chat.
 */
export function looksSecret(input) {
  const s = String(input || '');
  return SECRET_PATTERNS.some((re) => re.test(s)) || HEADER_HINTS.some((re) => re.test(s));
}

// --------------------------------------------------------------- dead letter queue

export function dlqPush({ userId, chatId, provider, model, prompt, error }) {
  const row = db.prepare(`
    INSERT INTO dlq (user_id, chat_id, provider, model, prompt, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, chatId, provider || null, model || null, redact(prompt), redact(error), Date.now());
  return row.lastInsertRowid;
}

export function dlqList(limit = 20) {
  return db.prepare('SELECT * FROM dlq ORDER BY id DESC LIMIT ?').all(limit);
}

export function dlqReplay(id) {
  const row = db.prepare('SELECT * FROM dlq WHERE id = ?').get(id);
  if (!row) return null;
  db.prepare('UPDATE dlq SET replayed = 1 WHERE id = ?').run(id);
  return row;
}
