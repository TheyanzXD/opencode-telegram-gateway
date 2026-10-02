import { tenantDb } from './tenant.js';
import { logger } from './logger.js';

// remember + recall via FTS5. No embeddings in v1 — pure BM25 keyword search.
// ponytail: when EMBEDDING_PROVIDER set, generate vectors and store alongside;
// recall switches to cosine top-K.

export function remember(userId, { source, body }) {
  if (!body || !body.trim()) return null;
  const db = tenantDb(userId);
  const ts = Date.now();
  const info = db.prepare(
    'INSERT INTO memory_chunks (source, body, created_at) VALUES (?, ?, ?)'
  ).run(source || 'manual', body, ts);
  db.prepare('INSERT INTO memory_fts (rowid, body, source) VALUES (?, ?, ?)').run(info.lastInsertRowid, body, source || 'manual');
  return info.lastInsertRowid;
}

export function forget(userId, chunkId) {
  const db = tenantDb(userId);
  db.prepare('DELETE FROM memory_chunks WHERE id = ?').run(chunkId);
  db.prepare('DELETE FROM memory_fts WHERE rowid = ?').run(chunkId);
}

export function recall(userId, query, k = 5) {
  const db = tenantDb(userId);
  if (!query || !query.trim()) return [];
  const ftsQuery = sanitizeFts(query);
  if (!ftsQuery) return [];
  try {
    const rows = db.prepare(`
      SELECT m.id, m.source, m.body, m.created_at,
             bm25(memory_fts) AS score
      FROM memory_fts mf
      JOIN memory_chunks m ON m.id = mf.rowid
      WHERE memory_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `).all(ftsQuery, k);
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      body: r.body,
      score: r.score,
      created_at: r.created_at,
    }));
  } catch (err) {
    logger.warn({ err: err.message, query }, 'memory recall failed');
    return [];
  }
}

// FTS5 needs careful token formatting. Strip quotes/operators, split on whitespace.
function sanitizeFts(q) {
  return q.replace(/["()*:^]/g, ' ').trim().split(/\s+/).filter(Boolean).map((t) => `"${t}"`).join(' ');
}

export function memoryStats(userId) {
  const db = tenantDb(userId);
  const total = db.prepare('SELECT COUNT(*) AS c FROM memory_chunks').get().c;
  const last7 = db.prepare('SELECT COUNT(*) AS c FROM memory_chunks WHERE created_at >= ?')
    .get(Date.now() - 7 * 86400_000).c;
  return { total, last7 };
}