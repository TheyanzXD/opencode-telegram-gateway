import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { logger } from './logger.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  user_id        INTEGER PRIMARY KEY,
  username       TEXT,
  first_name     TEXT,
  last_name      TEXT,
  is_banned      INTEGER NOT NULL DEFAULT 0,
  is_admin       INTEGER NOT NULL DEFAULT 0,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  temperature    REAL NOT NULL DEFAULT 0.7,
  system_prompt  TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  session_id INTEGER,
  role       TEXT NOT NULL CHECK(role IN ('system','user','assistant')),
  content    TEXT NOT NULL,
  tokens     INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(user_id, session_id);

CREATE TABLE IF NOT EXISTS usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  total_tokens      INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_user ON usage(user_id, created_at DESC);

-- Named conversation sessions per user
CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  name        TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(user_id, name),
  FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS proxies (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  scheme    TEXT NOT NULL,
  host      TEXT NOT NULL,
  port      INTEGER NOT NULL,
  username  TEXT,
  password  TEXT,
  source    TEXT,
  fails     INTEGER NOT NULL DEFAULT 0,
  ok_count  INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(scheme, host, port, username)
);

CREATE INDEX IF NOT EXISTS idx_proxies_fail ON proxies(fails, ok_count DESC);
`);

logger.info({ dbPath: config.dbPath }, 'database ready');

// ---- users ----
export function upsertUser({ user_id, username, first_name, last_name }) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO users (user_id, username, first_name, last_name, provider, model, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      updated_at = excluded.updated_at
  `).run(user_id, username || null, first_name || null, last_name || null,
         config.defaults.provider, config.defaults.model, now, now);
  return getUser(user_id);
}

export function getUser(user_id) {
  return db.prepare('SELECT * FROM users WHERE user_id = ?').get(user_id) || null;
}

export function setUserModel(user_id, provider, model) {
  db.prepare('UPDATE users SET provider = ?, model = ?, updated_at = ? WHERE user_id = ?')
    .run(provider, model, Date.now(), user_id);
}
export function setUserTemperature(user_id, temperature) {
  db.prepare('UPDATE users SET temperature = ?, updated_at = ? WHERE user_id = ?')
    .run(temperature, Date.now(), user_id);
}
export function setUserSystemPrompt(user_id, system_prompt) {
  db.prepare('UPDATE users SET system_prompt = ?, updated_at = ? WHERE user_id = ?')
    .run(system_prompt, Date.now(), user_id);
}
export function setBanned(user_id, is_banned) {
  db.prepare('UPDATE users SET is_banned = ?, updated_at = ? WHERE user_id = ?')
    .run(is_banned ? 1 : 0, Date.now(), user_id);
}

// ---- messages ----
export function addMessage(user_id, role, content, tokens = null, sessionId = null) {
  db.prepare(`
    INSERT INTO messages (user_id, session_id, role, content, tokens, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(user_id, sessionId, role, content, tokens, Date.now());
}
export function getHistory(user_id, limit = config.historyLimit, sessionId = null) {
  if (sessionId) {
    return db.prepare(`
      SELECT * FROM (
        SELECT * FROM messages WHERE user_id = ? AND session_id = ? ORDER BY id DESC LIMIT ?
      ) ORDER BY id ASC
    `).all(user_id, sessionId, limit);
  }
  return db.prepare(`
    SELECT * FROM (
      SELECT * FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?
    ) ORDER BY id ASC
  `).all(user_id, limit);
}
export function clearHistory(user_id, sessionId = null) {
  if (sessionId) {
    return db.prepare('DELETE FROM messages WHERE user_id = ? AND session_id = ?').run(user_id, sessionId).changes;
  }
  return db.prepare('DELETE FROM messages WHERE user_id = ?').run(user_id).changes;
}
export function sessionMessagesAll(user_id, sessionId) {
  return db.prepare('SELECT * FROM messages WHERE user_id = ? AND session_id = ? ORDER BY id ASC').all(user_id, sessionId);
}

// ---- usage ----
export function recordUsage({ user_id, provider, model, usage }) {
  if (!usage) return;
  db.prepare(`
    INSERT INTO usage (user_id, provider, model, prompt_tokens, completion_tokens, total_tokens, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(user_id, provider, model,
         usage.prompt_tokens ?? null, usage.completion_tokens ?? null, usage.total_tokens ?? null,
         Date.now());
}

// ---- stats ----
export function stats() {
  const u = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const b = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_banned = 1').get().c;
  const m = db.prepare('SELECT COUNT(*) AS c FROM messages').get().c;
  const tot = db.prepare('SELECT COALESCE(SUM(total_tokens),0) AS s FROM usage').get().s;
  return { users: u, banned: b, messages: m, total_tokens: tot };
}

// ---- sessions ----
export function createSession(user_id, name) {
  const now = Date.now();
  db.prepare('INSERT INTO sessions (user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(user_id, name, now, now);
  // Set all user's sessions inactive, then activate this one
  db.prepare('UPDATE sessions SET is_active = 0 WHERE user_id = ?').run(user_id);
  db.prepare('UPDATE sessions SET is_active = 1 WHERE user_id = ? AND name = ?').run(user_id, name);
  return getSession(user_id, name);
}
export function getSession(user_id, name) {
  return db.prepare('SELECT * FROM sessions WHERE user_id = ? AND name = ?').get(user_id, name) || null;
}
export function listSessions(user_id) {
  return db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY updated_at DESC').all(user_id);
}
export function deleteSession(user_id, name) {
  const sess = getSession(user_id, name);
  if (!sess) return 0;
  // Detach messages (keep as orphan history), then delete the session row.
  db.prepare('UPDATE messages SET session_id = NULL WHERE session_id = ?').run(sess.id);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sess.id);
  return 1;
}
export function activateSession(user_id, name) {
  const sess = getSession(user_id, name);
  if (!sess) return null;
  db.prepare('UPDATE sessions SET is_active = 0 WHERE user_id = ?').run(user_id);
  db.prepare('UPDATE sessions SET is_active = 1, updated_at = ? WHERE id = ?').run(Date.now(), sess.id);
  return sess;
}
export function getActiveSession(user_id) {
  return db.prepare('SELECT * FROM sessions WHERE user_id = ? AND is_active = 1').get(user_id) || null;
}

// ---- proxies ----
export function upsertProxy({ scheme, host, port, username, password, source }) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO proxies (scheme, host, port, username, password, source, last_seen, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scheme, host, port, username) DO UPDATE SET
      last_seen = excluded.last_seen
  `).run(scheme, host, port, username ?? null, password ?? null, source || null, now, now);
}
export function pickRandomProxy() {
  return db.prepare(`
    SELECT * FROM proxies
    WHERE fails < 5
    ORDER BY RANDOM()
    LIMIT 1
  `).get() || null;
}
export function pickProxyForChat(chatId) {
  // Stable pick: hash(chatId) → same proxy per chat, falls back to direct if pool empty
  const ids = db.prepare('SELECT id FROM proxies WHERE fails < 5 ORDER BY id').all();
  if (!ids.length) return null;
  let h = 0;
  for (const c of String(chatId)) h = (h * 31 + c.charCodeAt(0)) | 0;
  const idx = Math.abs(h) % ids.length;
  const id = ids[idx].id;
  return db.prepare('SELECT * FROM proxies WHERE id = ?').get(id);
}
export function pickProxyForChatWithRotation(chatId) {
  // Try the stable pick; if it has failed too many times, fall back to any
  // healthy proxy so a dead entry doesn't permanently break one chat.
  const p = pickProxyForChat(chatId);
  if (p) return p;
  return pickRandomProxy();
}
export function proxyOk(id) {
  db.prepare('UPDATE proxies SET ok_count = ok_count + 1, last_seen = ? WHERE id = ?').run(Date.now(), id);
}
export function proxyFail(id) {
  db.prepare('UPDATE proxies SET fails = fails + 1, last_seen = ? WHERE id = ?').run(Date.now(), id);
}
export function proxyStats() {
  return {
    total: db.prepare('SELECT COUNT(*) AS c FROM proxies').get().c,
    healthy: db.prepare('SELECT COUNT(*) AS c FROM proxies WHERE fails < 5').get().c,
    dead: db.prepare('SELECT COUNT(*) AS c FROM proxies WHERE fails >= 5').get().c,
  };
}
export function pruneProxies() {
  return db.prepare('DELETE FROM proxies WHERE fails >= 20').run().changes;
}
