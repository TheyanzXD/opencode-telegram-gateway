import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { logger } from './logger.js';

fs.mkdirSync(config.tenants.dir, { recursive: true });

const cache = new Map(); // userId -> Database

function ensureSchema(db, userId) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS prefs (
      user_id       INTEGER PRIMARY KEY,
      provider      TEXT,
      model         TEXT,
      temperature   REAL,
      system_prompt TEXT,
      cwd           TEXT,
      gh_token      TEXT,
      gh_login      TEXT,
      mcp_enabled   INTEGER NOT NULL DEFAULT 0,
      mcp_servers   TEXT,
      updated_at    INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      is_active  INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(name)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL,
      session_id    INTEGER,
      role          TEXT NOT NULL CHECK(role IN ('system','user','assistant','tool')),
      content       TEXT NOT NULL,
      tokens        INTEGER,
      tool_call_id  TEXT,
      tool_name     TEXT,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id DESC);
    CREATE TABLE IF NOT EXISTS tool_audit (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_name   TEXT NOT NULL,
      args_json   TEXT,
      ok          INTEGER NOT NULL,
      output      TEXT,
      duration_ms INTEGER,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_time ON tool_audit(created_at DESC);
    CREATE TABLE IF NOT EXISTS memory_chunks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      source     TEXT NOT NULL,
      body       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      body, source,
      content='memory_chunks',
      content_rowid='id',
      tokenize='porter unicode61'
    );
  `);
}

function pathFor(userId) {
  return path.join(config.tenants.dir, `${userId}.db`);
}

export function tenantDb(userId) {
  if (!userId) throw new Error('tenantDb: userId required');
  let db = cache.get(userId);
  if (db) return db;
  const p = pathFor(userId);
  db = new Database(p);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureSchema(db, userId);
  cache.set(userId, db);
  logger.debug({ userId, path: p }, 'tenant opened');
  return db;
}

export function withTenant(userId, fn) {
  return fn(tenantDb(userId));
}

export function listTenants() {
  if (!fs.existsSync(config.tenants.dir)) return [];
  return fs.readdirSync(config.tenants.dir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => parseInt(f.slice(0, -3), 10))
    .filter((n) => Number.isFinite(n));
}

export function dropTenant(userId) {
  const db = cache.get(userId);
  if (db) { try { db.close(); } catch { /* ignore */ } cache.delete(userId); }
  const p = pathFor(userId);
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(p + ext); } catch { /* ignore */ }
  }
}

export function closeAll() {
  for (const [uid, db] of cache) {
    try { db.close(); } catch { /* ignore */ }
  }
  cache.clear();
}