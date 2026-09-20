// language: JavaScript (Node 20+ ESM), file: src/agent/store-kv.js
// A separate SQLite handle for agent-side tables that do not belong in db.js.
//
// Why its own connection: db.js owns the chat schema and is imported everywhere.
// The agent's working store is volatile, high-churn, and experiment-prone —
// keeping it on a second handle means a bad migration here can never take the
// bot's conversation tables down with it.

import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { logger } from '../logger.js';

const dbPath = config.dbPath;

let _db = null;
function handle() {
  if (_db) return _db;
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.exec(`
    -- Long-term memory: durable facts, learned or stated by the user.
    -- kind separates preferences from knowledge from project context, so a
    -- recall can be scoped ("what do I know about this project?").
    CREATE TABLE IF NOT EXISTS lt_memory (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    TEXT NOT NULL,
      kind       TEXT NOT NULL DEFAULT 'fact',  -- fact | preference | project
      -- NOT NULL with '' as the empty case: a UNIQUE constraint on a nullable
      -- column does not fire when the value is NULL, so a keyless fact could be
      -- inserted infinitely instead of upserting.
      key        TEXT NOT NULL DEFAULT '',
      value      TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      hits       INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id, kind, key, value)
    );
    CREATE INDEX IF NOT EXISTS idx_ltmem_user ON lt_memory(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ltmem_kind ON lt_memory(user_id, kind, updated_at DESC);
    -- A UNIQUE constraint on a nullable column does not fire when the column is
    -- NULL, so a fact stored without a key could be inserted infinitely. This
    -- expression index is what the ON CONFLICT upsert actually matches against.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ltmem_dedup
      ON lt_memory(user_id, kind, COALESCE(key, ''), value);

    -- Lessons: a failed attempt and the correction that worked. Matched by
    -- similarity of the problem text, not by hash — the same failure rarely
    -- repeats with identical wording.
    CREATE TABLE IF NOT EXISTS lessons (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    TEXT NOT NULL,
      problem    TEXT NOT NULL,
      solution   TEXT NOT NULL,
      context    TEXT,
      hits       INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id, problem)
    );
    CREATE INDEX IF NOT EXISTS idx_lessons_user ON lessons(user_id, updated_at DESC);

    -- Decision journal: why the agent chose one path over another, so a user
    -- can ask "why did you do it that way?" and get an answer, not a shrug.
    CREATE TABLE IF NOT EXISTS decisions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    TEXT NOT NULL,
      session_id TEXT,
      chose      TEXT NOT NULL,
      rejected   TEXT,
      reason     TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_user ON decisions(user_id, created_at DESC);
  `);
  logger.info('agent store ready');
  return _db;
}

// --------------------------------------------------------------- long-term memory

export function remember(userId, kind, value, key = null, confidence = 1.0) {
  const db = handle();
  const now = Date.now();
  db.prepare(`
    INSERT INTO lt_memory (user_id, kind, key, value, confidence, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, kind, key, value) DO UPDATE SET
      confidence = MAX(excluded.confidence, lt_memory.confidence),
      updated_at = excluded.updated_at
  `).run(String(userId), kind, key || '', value, confidence, now, now);
}

export function forgetMemory(userId, kind = null, value = null) {
  const db = handle();
  if (value) {
    return db.prepare('DELETE FROM lt_memory WHERE user_id = ? AND value = ?').run(String(userId), value).changes;
  }
  if (kind) {
    return db.prepare('DELETE FROM lt_memory WHERE user_id = ? AND kind = ?').run(String(userId), kind).changes;
  }
  return db.prepare('DELETE FROM lt_memory WHERE user_id = ?').run(String(userId)).changes;
}

/**
 * Recall durable facts for a user.
 * @param {string} userId
 * @param {object} [opts] {kind, limit, minConfidence}
 * @returns {Array<{kind:string, key:string|null, value:string, confidence:number}>}
 */
export function recall(userId, { kind = null, limit = 30, minConfidence = 0.3 } = {}) {
  const db = handle();
  const rows = kind
    ? db.prepare('SELECT kind, key, value, confidence FROM lt_memory WHERE user_id = ? AND kind = ? AND confidence >= ? ORDER BY confidence DESC, updated_at DESC LIMIT ?')
        .all(String(userId), kind, minConfidence, limit)
    : db.prepare('SELECT kind, key, value, confidence FROM lt_memory WHERE user_id = ? AND confidence >= ? ORDER BY confidence DESC, updated_at DESC LIMIT ?')
        .all(String(userId), minConfidence, limit);
  // Bump hit counts lazily — a memory that is never recalled is a memory
  // that can be pruned later without anyone noticing it went missing.
  try {
    const bump = db.prepare('UPDATE lt_memory SET hits = hits + 1 WHERE user_id = ? AND value = ?');
    for (const r of rows) bump.run(String(userId), r.value);
  } catch { /* non-fatal */ }
  return rows;
}

export function memoryStats(userId) {
  const db = handle();
  const total = db.prepare('SELECT COUNT(*) AS c FROM lt_memory WHERE user_id = ?').get(String(userId)).c;
  const byKind = db.prepare('SELECT kind, COUNT(*) AS c FROM lt_memory WHERE user_id = ? GROUP BY kind').all(String(userId));
  return { total, byKind };
}

// --------------------------------------------------------------- lessons

export function recordLesson(userId, problem, solution, context = null) {
  const db = handle();
  const now = Date.now();
  // Same problem twice → keep the newest solution, reset hits.
  db.prepare(`
    INSERT INTO lessons (user_id, problem, solution, context, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, problem) DO UPDATE SET
      solution = excluded.solution,
      context = excluded.context,
      hits = 0,
      updated_at = excluded.updated_at
  `).run(String(userId), problem, solution, context, now, now);
}

/**
 * Find lessons whose problem resembles this one.
 * @returns {Array<{problem:string, solution:string}>}
 */
export function findLessons(userId, problemText, limit = 3) {
  const db = handle();
  const rows = db.prepare(`
    SELECT problem, solution, hits FROM lessons
    WHERE user_id = ?
    ORDER BY hits DESC, updated_at DESC
    LIMIT ?
  `).all(String(userId), limit * 4);
  if (!rows.length) return [];
  // Rank by token overlap with the current problem. Exact-match is too strict
  // — the same failure rarely repeats with identical wording — and a vector
  // store would need an embedding model this gateway does not assume.
  const want = new Set(tokenize(problemText));
  const scored = rows.map((r) => {
    const have = new Set(tokenize(r.problem));
    let overlap = 0;
    for (const w of have) if (want.has(w)) overlap++;
    return { ...r, score: overlap / Math.max(1, Math.min(want.size, have.size)) };
  });
  const hits = scored.filter((r) => r.score >= 0.25).sort((a, b) => b.score - a.score).slice(0, limit);
  if (hits.length) {
    const bump = db.prepare('UPDATE lessons SET hits = hits + 1 WHERE user_id = ? AND problem = ?');
    for (const h of hits) bump.run(String(userId), h.problem);
  }
  return hits.map(({ problem, solution }) => ({ problem, solution }));
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3)
    .filter((w) => !STOP.has(w));
}
const STOP = new Set(['this', 'that', 'with', 'from', 'have', 'been', 'will', 'would', 'could', 'should', 'about', 'after', 'before', 'there', 'their', 'which', 'while']);

// --------------------------------------------------------------- decisions

export function recordDecision(userId, chose, reason, rejected = null, sessionId = null) {
  const db = handle();
  db.prepare(`
    INSERT INTO decisions (user_id, session_id, chose, rejected, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(String(userId), sessionId, chose, rejected, reason, Date.now());
}

export function recentDecisions(userId, limit = 10) {
  const db = handle();
  return db.prepare(`
    SELECT chose, rejected, reason, created_at FROM decisions
    WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(String(userId), limit);
}
