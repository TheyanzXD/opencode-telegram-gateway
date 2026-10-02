import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { logger } from './logger.js';
import {
  addMessage as _addMessage,
  getHistory as _getHistory,
  clearHistory as _clearHistory,
  sessionMessagesAll as _sessionMessagesAll,
  createSession as _createSession,
  getSession as _getSession,
  listSessions as _listSessions,
  deleteSession as _deleteSession,
  activateSession as _activateSession,
  getActiveSession as _getActiveSession,
  getPrefs as _getPrefs,
  upsertPrefs as _upsertPrefs,
  clearGhToken as _clearGhToken,
  auditTool as _auditTool,
  auditStats as _auditStats,
  messageStats as _messageStats,
} from './tenant_messages.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);

// --- High-performance tuning (v2) -------------------------------------------
// WAL: readers never block the writer, and the writer never blocks readers.
// synchronous=NORMAL is safe under WAL (no corruption on power loss — the WAL
// is fsynced on checkpoint; only the last transaction may be lost) and cuts
// commit latency by an order of magnitude vs FULL.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
// Page cache: negative = kilobytes, so -64000 ≈ 64 MB of hot pages in RAM.
db.pragma('cache_size = -64000');
// Memory-mapped reads: the file is mapped into the address space, so a read
// hits the page cache directly instead of going through a read() syscall.
db.pragma('mmap_size = 268435456'); // 256 MB
db.pragma('temp_store = MEMORY');
// 5 s is generous under WAL; a busy write holds the lock far shorter now.
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

/**
 * Prepared statement cache. db.prepare() parses and plans SQL every call —
 * on a hot message path that is pure wasted CPU. Compile once, reuse forever.
 * The map is keyed by the SQL string itself, which is exact and stable.
 */
const stmtCache = new Map();
export function getStatement(sql) {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  user_id        INTEGER PRIMARY KEY,
  username       TEXT,
  first_name     TEXT,
  last_name     TEXT,
  is_banned      INTEGER NOT NULL DEFAULT 0,
  is_admin       INTEGER NOT NULL DEFAULT 0,
  is_tenant      INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_banned ON users(is_banned);

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

CREATE TABLE IF NOT EXISTS _meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
`);

function migrate(db) {
  const stmts = [
    'ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN is_tenant INTEGER NOT NULL DEFAULT 0',
  ];
  for (const sql of stmts) {
    try { db.exec(sql); }
    catch (err) {
      if (!/duplicate column/i.test(err.message)) throw err;
    }
  }
}
migrate(db);

logger.info({ dbPath: config.dbPath }, 'database ready');

// ---- users (global identity only) ----
export function upsertUser({ user_id, username, first_name, last_name }) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO users (user_id, username, first_name, last_name, is_tenant, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      updated_at = excluded.updated_at
  `).run(user_id, username || null, first_name || null, last_name || null, now, now);
  return getUser(user_id);
}
export function getUser(user_id) {
  const u = db.prepare('SELECT * FROM users WHERE user_id = ?').get(user_id) || null;
  if (!u) return null;
  // Merge prefs (provider/model/etc) from tenant
  const prefs = _getPrefs(user_id) || {};
  return {
    ...u,
    provider: prefs.provider ?? config.defaults.provider,
    model: prefs.model ?? config.defaults.model,
    temperature: prefs.temperature ?? config.defaults.temperature,
    system_prompt: prefs.system_prompt ?? null,
    cwd: prefs.cwd ?? null,
    gh_token: prefs.gh_token ?? null,
    gh_login: prefs.gh_login ?? null,
    mcp_enabled: prefs.mcp_enabled ?? 0,
    mcp_servers: prefs.mcp_servers ?? null,
  };
}
export function setBanned(user_id, is_banned) {
  getStatement('UPDATE users SET is_banned = ?, updated_at = ? WHERE user_id = ?')
    .run(is_banned ? 1 : 0, Date.now(), user_id);
}
export function setUserAdmin(user_id, is_admin) {
  db.prepare('UPDATE users SET is_admin = ?, updated_at = ? WHERE user_id = ?')
    .run(is_admin ? 1 : 0, Date.now(), user_id);
}

// ---- usage (global rollup) ----
export function recordUsage({ user_id, provider, model, usage }) {
  if (!usage) return;
  getStatement(`
    INSERT INTO usage (user_id, provider, model, prompt_tokens, completion_tokens, total_tokens, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(user_id, provider, model,
         usage.prompt_tokens ?? null, usage.completion_tokens ?? null, usage.total_tokens ?? null,
         Date.now());
}

// ---- prefs wrappers (write through to tenant DB) ----
export function setUserModel(user_id, provider, model) { _upsertPrefs(user_id, { provider, model }); }
export function setUserTemperature(user_id, t) { _upsertPrefs(user_id, { temperature: t }); }
export function setUserSystemPrompt(user_id, p) { _upsertPrefs(user_id, { system_prompt: p }); }
export function setUserCwd(user_id, cwd) { _upsertPrefs(user_id, { cwd }); }
export function setUserGhToken(user_id, token, login) { _upsertPrefs(user_id, { gh_token: token, gh_login: login }); }
export function clearUserGhToken(user_id) { _clearGhToken(user_id); }
export function setUserMcp(user_id, enabled, servers) {
  _upsertPrefs(user_id, { mcp_enabled: enabled ? 1 : 0, mcp_servers: servers || null });
}

// ---- messages / sessions (forwarded to tenant DB) ----
export const addMessage = _addMessage;
export const getHistory = _getHistory;
export const clearHistory = _clearHistory;
export const sessionMessagesAll = _sessionMessagesAll;
export const createSession = _createSession;
export const getSession = _getSession;
export const listSessions = _listSessions;
export const deleteSession = _deleteSession;
export const activateSession = _activateSession;
export const getActiveSession = _getActiveSession;

// ---- audit / stats (forwarded to tenant DB) ----
export const auditTool = _auditTool;
export const auditStats = _auditStats;
export const messageStats = _messageStats;

// ---- stats (global) ----
import { listTenants, tenantDb } from './tenant.js';
export function stats() {
  const u = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const b = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_banned = 1').get().c;
  const tot = db.prepare('SELECT COALESCE(SUM(total_tokens),0) AS s FROM usage').get().s;
  // Aggregate message count across all tenants.
  let messages = 0;
  for (const uid of listTenants()) {
    try { messages += tenantDb(uid).prepare('SELECT COUNT(*) AS c FROM messages').get().c; }
    catch { /* tenant may be in transition */ }
  }
  return { users: u, banned: b, total_tokens: tot, messages };
}
export function usageByUser(user_id, days = 30) {
  return db.prepare(`
    SELECT provider, model,
           SUM(prompt_tokens) AS prompt_tokens,
           SUM(completion_tokens) AS completion_tokens,
           SUM(total_tokens) AS total_tokens,
           COUNT(*) AS calls
    FROM usage WHERE user_id = ? AND created_at >= ?
    GROUP BY provider, model
    ORDER BY total_tokens DESC NULLS LAST
  `).all(user_id, Date.now() - days * 86400_000);
}

// ---- admin export helpers: aggregate across all tenant DBs ----
export function allMessages(filterUserId = null) {
  const out = [];
  for (const uid of listTenants()) {
    if (filterUserId && uid !== filterUserId) continue;
    try {
      const rows = tenantDb(uid).prepare('SELECT * FROM messages ORDER BY id ASC').all();
      out.push(...rows);
    } catch { /* skip broken tenant */ }
  }
  return out;
}
export function allSessions(filterUserId = null) {
  const out = [];
  for (const uid of listTenants()) {
    if (filterUserId && uid !== filterUserId) continue;
    try {
      const rows = tenantDb(uid).prepare('SELECT * FROM sessions ORDER BY id ASC').all();
      for (const r of rows) r.user_id = uid; // stamp owner
      out.push(...rows);
    } catch { /* skip */ }
  }
  return out;
}

// ---- proxies (unchanged) ----
export function upsertProxy({ scheme, host, port, source }) {
  const now = Date.now();
  getStatement(`
    INSERT INTO proxies (scheme, host, port, username, password, source, last_seen, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scheme, host, port, username) DO UPDATE SET
      last_seen = excluded.last_seen
  `).run(scheme, host, port, username ?? null, password ?? null, source || null, now, now);
}
export function pickRandomProxy() {
  return db.prepare(`
    SELECT * FROM proxies WHERE fails < 5 ORDER BY RANDOM() LIMIT 1
  `).get() || null;
}
export function pickProxyForChat(chatId) {
  const ids = db.prepare('SELECT id FROM proxies WHERE fails < 5 ORDER BY id').all();
  if (!ids.length) return null;
  let h = 0;
  for (const c of String(chatId)) h = (h * 31 + c.charCodeAt(0)) | 0;
  const idx = Math.abs(h) % ids.length;
  return db.prepare('SELECT * FROM proxies WHERE id = ?').get(ids[idx].id);
}
export function proxyOk(id) {
  getStatement('UPDATE proxies SET ok_count = ok_count + 1, last_seen = ? WHERE id = ?').run(Date.now(), id);
}
export function proxyFail(id) {
  getStatement('UPDATE proxies SET fails = fails + 1, last_seen = ? WHERE id = ?').run(Date.now(), id);
}
export function proxyStats() {
  return {
    total: getStatement('SELECT COUNT(*) AS c FROM proxies').get().c,
    healthy: getStatement('SELECT COUNT(*) AS c FROM proxies WHERE fails < 5').get().c,
    dead: getStatement('SELECT COUNT(*) AS c FROM proxies WHERE fails >= 5').get().c,
  };
}
export function pruneProxies() {
  return getStatement('DELETE FROM proxies WHERE fails >= 20').run().changes;
}

// ---- meta (one-shot migration flag) ----
export function metaGet(k) {
  return db.prepare('SELECT v FROM _meta WHERE k = ?').get(k)?.v ?? null;
}
export function metaSet(k, v) {
  db.prepare('INSERT INTO _meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, v);
}

// ---- legacy migration: move old users.{provider,model,temperature,system_prompt,cwd,gh_token,gh_login}
//      columns into per-tenant prefs. One-shot. ----
export function migrateLegacyPrefs() {
  if (metaGet('legacy_prefs_v1')) return;
  const hasOld = db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === 'provider');
  if (!hasOld) { metaSet('legacy_prefs_v1', '1'); return; }
  const rows = db.prepare(`
    SELECT user_id, provider, model, temperature, system_prompt, cwd, gh_token, gh_login
    FROM users WHERE provider IS NOT NULL OR model IS NOT NULL OR cwd IS NOT NULL OR gh_token IS NOT NULL
  `).all();
  let n2 = 0;
  for (const r of rows) {
    _upsertPrefs(r.user_id, {
      provider: r.provider, model: r.model,
      temperature: r.temperature, system_prompt: r.system_prompt,
      cwd: r.cwd, gh_token: r.gh_token, gh_login: r.gh_login,
    });
    n2++;
  }
  metaSet('legacy_prefs_v1', '1');
  logger.info({ users_migrated: n2 }, 'legacy prefs migrated to tenant DBs');
}