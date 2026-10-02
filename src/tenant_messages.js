import { tenantDb } from './tenant.js';

// Messages
export function addMessage(user_id, role, content, tokens = null, sessionId = null, extra = {}) {
  tenantDb(user_id).prepare(`
    INSERT INTO messages (user_id, session_id, role, content, tokens, tool_call_id, tool_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(user_id, sessionId, role, content, tokens, extra.tool_call_id ?? null, extra.tool_name ?? null, Date.now());
}

export function getHistory(user_id, limit, sessionId = null) {
  const db = tenantDb(user_id);
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
  const db = tenantDb(user_id);
  if (sessionId) {
    return db.prepare('DELETE FROM messages WHERE user_id = ? AND session_id = ?').run(user_id, sessionId).changes;
  }
  return db.prepare('DELETE FROM messages WHERE user_id = ?').run(user_id).changes;
}

export function sessionMessagesAll(user_id, sessionId) {
  return tenantDb(user_id).prepare(
    'SELECT * FROM messages WHERE user_id = ? AND session_id = ? ORDER BY id ASC'
  ).all(user_id, sessionId);
}

// Sessions
export function createSession(user_id, name) {
  const now = Date.now();
  const db = tenantDb(user_id);
  db.prepare('INSERT INTO sessions (name, created_at, updated_at) VALUES (?, ?, ?)').run(name, now, now);
  db.prepare('UPDATE sessions SET is_active = 0').run();
  db.prepare('UPDATE sessions SET is_active = 1, updated_at = ? WHERE name = ?').run(now, name);
  return getSession(user_id, name);
}
export function getSession(user_id, name) {
  return tenantDb(user_id).prepare('SELECT * FROM sessions WHERE name = ?').get(name) || null;
}
export function listSessions(user_id) {
  return tenantDb(user_id).prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all(user_id);
}
export function deleteSession(user_id, name) {
  const db = tenantDb(user_id);
  const sess = getSession(user_id, name);
  if (!sess) return 0;
  db.prepare('UPDATE messages SET session_id = NULL WHERE session_id = ?').run(sess.id);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sess.id);
  return 1;
}
export function activateSession(user_id, name) {
  const db = tenantDb(user_id);
  const sess = getSession(user_id, name);
  if (!sess) return null;
  db.prepare('UPDATE sessions SET is_active = 0').run();
  db.prepare('UPDATE sessions SET is_active = 1, updated_at = ? WHERE id = ?').run(Date.now(), sess.id);
  return sess;
}
export function getActiveSession(user_id) {
  return tenantDb(user_id).prepare('SELECT * FROM sessions WHERE is_active = 1').get() || null;
}

// Prefs (per-user config; replaces scattered columns in global users table)
export function getPrefs(user_id) {
  return tenantDb(user_id).prepare('SELECT * FROM prefs WHERE user_id = ?').get(user_id) || null;
}
export function upsertPrefs(user_id, patch) {
  const cur = getPrefs(user_id) || {};
  const merged = {
    provider: patch.provider ?? cur.provider ?? null,
    model: patch.model ?? cur.model ?? null,
    temperature: patch.temperature ?? cur.temperature ?? null,
    system_prompt: patch.system_prompt ?? cur.system_prompt ?? null,
    cwd: patch.cwd ?? cur.cwd ?? null,
    gh_token: patch.gh_token ?? cur.gh_token ?? null,
    gh_login: patch.gh_login ?? cur.gh_login ?? null,
    mcp_enabled: patch.mcp_enabled ?? cur.mcp_enabled ?? 0,
    mcp_servers: patch.mcp_servers ?? cur.mcp_servers ?? null,
  };
  tenantDb(user_id).prepare(`
    INSERT INTO prefs (user_id, provider, model, temperature, system_prompt, cwd, gh_token, gh_login, mcp_enabled, mcp_servers, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      provider=excluded.provider, model=excluded.model, temperature=excluded.temperature,
      system_prompt=excluded.system_prompt, cwd=excluded.cwd, gh_token=excluded.gh_token,
      gh_login=excluded.gh_login, mcp_enabled=excluded.mcp_enabled, mcp_servers=excluded.mcp_servers,
      updated_at=excluded.updated_at
  `).run(user_id, merged.provider, merged.model, merged.temperature, merged.system_prompt, merged.cwd,
         merged.gh_token, merged.gh_login, merged.mcp_enabled, merged.mcp_servers, Date.now());
  return getPrefs(user_id);
}

export function clearGhToken(user_id) {
  tenantDb(user_id).prepare('UPDATE prefs SET gh_token = NULL, gh_login = NULL, updated_at = ? WHERE user_id = ?')
    .run(Date.now(), user_id);
}

// Tool audit
export function auditTool(user_id, { tool_name, args, ok, output, duration_ms }) {
  tenantDb(user_id).prepare(`
    INSERT INTO tool_audit (tool_name, args_json, ok, output, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(tool_name, JSON.stringify(args || {}), ok ? 1 : 0, output || null, duration_ms ?? null, Date.now());
}

export function auditStats(user_id, { since = 0 } = {}) {
  return tenantDb(user_id).prepare(`
    SELECT tool_name, COUNT(*) AS n,
           SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok_n
    FROM tool_audit WHERE created_at >= ? GROUP BY tool_name ORDER BY n DESC
  `).all(since);
}

export function messageStats(user_id) {
  const db = tenantDb(user_id);
  const total = db.prepare('SELECT COUNT(*) AS c FROM messages').get().c;
  const last30 = db.prepare(
    "SELECT COUNT(*) AS c FROM messages WHERE created_at >= ?"
  ).get(Date.now() - 30 * 86400_000).c;
  const sess = db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c;
  const mem = db.prepare('SELECT COUNT(*) AS c FROM memory_chunks').get().c;
  return { total_messages: total, last30_messages: last30, sessions: sess, memory_chunks: mem };
}