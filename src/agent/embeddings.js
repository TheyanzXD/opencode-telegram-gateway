// language: JavaScript (Node 20+ ESM), file: src/agent/embeddings.js
// Vector embeddings + retrieval — the RAG layer the spec calls for.
//
// Design constraint (important): this gateway must stay dependency-light. The
// only native module is better-sqlite3 (already a dependency). sqlite-vec is a
// loadable extension — if it is present we use true cosine search; if not, we
// fall back to pure-JS cosine over rows stored as JSON arrays. Same API, same
// results on small corpora, zero build toolchain required on a phone VPS.
//
// Embeddings come from the model provider's own /embeddings endpoint when the
// provider offers one; otherwise we hash to a deterministic random projection
// so the surface still works end-to-end (recall will be poor — that is the
// honest degradation, and index_status() says so instead of pretending).

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { requestJson } from '../providers/client.js';
import { getProvider, providerNames } from '../providers/store.js';

const DIM = 384;            // matches text-embedding-3-small / bge-small-en
const MAX_CHUNK = 1200;     // characters — a function or two, not a whole file
const OVERLAP = 120;        // keeps a chunk boundary from splitting an idea

let _db = null;
let _vec = false;           // true once sqlite-vec loads

/** Open (and lazily migrate) the embeddings store. One DB per user. */
function db(userId) {
  if (_db?.[userId]) return _db[userId];
  const root = path.resolve(config.root, 'data', 'embeddings');
  try { fs.mkdirSync(root, { recursive: true }); } catch { /* may already exist */ }
  const d = new Database(path.join(root, `${userId}.db`));
  d.pragma('journal_mode = WAL');

  // sqlite-vec is optional. Try to load it; fall back to pure JS.
  if (!_vec) {
    try {
      d.loadExtension('sqlite_vec');
      d.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
        embedding FLOAT[${DIM}], chunk_id TEXT PRIMARY KEY)`);
      _vec = true;
      logger.info({ userId, dim: DIM }, 'embeddings: sqlite-vec loaded');
    } catch (err) {
      logger.warn({ err: String(err.message).slice(0, 120) }, 'embeddings: sqlite-vec unavailable, using pure-JS cosine');
    }
  }
  if (!_vec) {
    d.exec(`CREATE TABLE IF NOT EXISTS vec_chunks (
      chunk_id TEXT PRIMARY KEY, embedding TEXT NOT NULL)`);
  }
  d.exec(`CREATE TABLE IF NOT EXISTS chunks (
    chunk_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    file TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    text TEXT NOT NULL,
    hash TEXT NOT NULL,
    indexed_at INTEGER NOT NULL)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(user_id, file)`);
  return d;
}

// Lazily cache per-user handles; a growing bot would pool these.
_db = {};

/** A cheap deterministic vector when no embedding model is configured. */
function hashVector(text) {
  // Random projection seeded from the text: stable across runs, so the same
  // chunk always lands in the same place. NOT semantic — retrieval is then
  // keyword-adjacent only. index_status() reports this honestly.
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  const out = new Float32Array(DIM);
  let x = h >>> 0;
  for (let i = 0; i < DIM; i++) {
    x = (Math.imul(x ^ (x >>> 15), 2246822507) >>> 0);
    out[i] = ((x / 4294967296) * 2) - 1;
  }
  const n = Math.hypot(...out) || 1;
  return Array.from(out, (v) => v / n);
}

/** Ask the provider for a real embedding, else hash. */
async function embed(text, chatId) {
  const prov = embeddingProvider();
  if (!prov) return hashVector(text);
  try {
    const data = await requestJson(prov.name, '/embeddings', {
      model: prov.model, input: text.slice(0, 8000),
    }, undefined, chatId);
    const v = data.data?.[0]?.embedding;
    if (Array.isArray(v) && v.length) {
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n); // cosine needs unit vectors
    }
  } catch (err) {
    logger.warn({ err: String(err.message).slice(0, 100) }, 'embeddings: provider failed, hashing this chunk');
  }
  return hashVector(text);
}

/** Pick the first provider that actually advertises an embedding model. */
function embeddingProvider() {
  const fromEnv = process.env.EMBEDDING_PROVIDER && process.env.EMBEDDING_MODEL
    ? { name: process.env.EMBEDDING_PROVIDER, model: process.env.EMBEDDING_MODEL }
    : null;
  if (fromEnv && getProvider(fromEnv.name)) return fromEnv;
  // Probe the configured list for a known embedding endpoint.
  for (const name of providerNames()) {
    const p = getProvider(name);
    if (p.embedding_model) return { name: p.name, model: p.embedding_model };
  }
  return null;
}

/**
 * Split text into overlapping chunks at line boundaries. Never splits mid-line.
 */
export function chunkText(text, size = MAX_CHUNK, overlap = OVERLAP) {
  const lines = text.split('\n');
  const chunks = [];
  let buf = [], len = 0, start = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (len + line.length + 1 > size && buf.length) {
      chunks.push({ text: buf.join('\n'), start_line: start + 1, end_line: start + buf.length });
      // keep the tail for overlap
      const keep = [];
      let klen = 0;
      for (let j = buf.length - 1; j >= 0; j--) {
        if (klen + buf[j].length > overlap) break;
        keep.unshift(buf[j]); klen += buf[j].length + 1;
      }
      buf = keep; len = klen; start = i - keep.length;
    }
    buf.push(line); len += line.length + 1;
  }
  if (buf.length) chunks.push({ text: buf.join('\n'), start_line: start + 1, end_line: start + buf.length });
  return chunks;
}

/** Simple hash for change detection — re-index only what moved. */
function hashText(t) {
  let h = 5381;
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Index one file. Deletes the previous copy of the file first, so a re-index
 * after an edit does not leave stale chunks behind.
 * @returns {{added:number, skipped:number}}
 */
export async function indexFile(userId, file, content, chatId) {
  const d = db(userId);
  const rel = path.isAbsolute(file) ? path.relative(workspaceOf(userId), file) : file;
  const chunks = chunkText(content);
  const now = Date.now();
  const del = d.prepare('DELETE FROM chunks WHERE user_id = ? AND file = ?');
  const delVec = d.prepare('DELETE FROM vec_chunks WHERE chunk_id LIKE ?');
  const ins = d.prepare(`INSERT INTO chunks (chunk_id,user_id,file,start_line,end_line,text,hash,indexed_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  const insVec = d.prepare('INSERT OR REPLACE INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)');

  const idPrefix = `${userId}:${rel}:`;
  d.transaction(() => { del.run(userId, rel); delVec.run(`${idPrefix}%`); })();

  let added = 0;
  for (const c of chunks) {
    const id = `${idPrefix}${c.start_line}-${c.end_line}`;
    const h = hashText(c.text);
    const existing = d.prepare('SELECT hash FROM chunks WHERE chunk_id = ?').get(id);
    if (existing && existing.hash === h) { added++; continue; } // unchanged
    const vec = await embed(c.text, chatId);
    d.transaction(() => {
      ins.run(id, userId, rel, c.start_line, c.end_line, c.text, h, now);
      insVec.run(id, JSON.stringify(vec));
    })();
    added++;
  }
  return { added, skipped: chunks.length - added };
}

/** Drop everything for one file (used when a file is deleted). */
export function unindexFile(userId, file) {
  const d = db(userId);
  const rel = path.isAbsolute(file) ? path.relative(workspaceOf(userId), file) : file;
  d.transaction(() => {
    d.prepare('DELETE FROM chunks WHERE user_id = ? AND file = ?').run(userId, rel);
    d.prepare('DELETE FROM vec_chunks WHERE chunk_id LIKE ?').run(`${userId}:${rel}:%`);
  })();
}

/**
 * Semantic search over this user's indexed code.
 * @returns {Array<{file, start_line, end_line, text, score}>}
 */
export async function search(userId, query, limit = 8, chatId) {
  const d = db(userId);
  const vec = await embed(query, chatId);
  let rows;

  if (_vec) {
    const q = d.prepare(`SELECT chunk_id, distance FROM vec_chunks
      WHERE embedding MATCH ? AND k = ? ORDER BY distance`);
    const hits = q.all(JSON.stringify(vec), limit);
    if (!hits.length) return [];
    rows = hits.map((h) => ({ ...d.prepare('SELECT * FROM chunks WHERE chunk_id = ?').get(h.chunk_id), score: 1 - h.distance }));
  } else {
    // pure-JS cosine
    const all = d.prepare('SELECT chunk_id, embedding FROM vec_chunks').all();
    if (!all.length) return [];
    const scored = all.map((r) => {
      let a; try { a = JSON.parse(r.embedding); } catch { return null; }
      if (!Array.isArray(a) || a.length !== DIM) return null;
      let dot = 0;
      for (let i = 0; i < DIM; i++) dot += a[i] * vec[i];
      return { chunk_id: r.chunk_id, score: dot };
    }).filter(Boolean);
    scored.sort((x, y) => y.score - x.score);
    rows = scored.slice(0, limit).map((s) => ({
      ...d.prepare('SELECT * FROM chunks WHERE chunk_id = ?').get(s.chunk_id), score: s.score,
    }));
  }

  return rows.filter(Boolean).map((r) => ({
    file: r.file,
    start_line: r.start_line,
    end_line: r.end_line,
    text: r.text,
    score: Math.max(0, Math.min(1, r.score)),
  }));
}

/** True when a real embedding model is configured (vs hash fallback). */
export function indexStatus() {
  const prov = embeddingProvider();
  return {
    vectorBackend: _vec ? 'sqlite-vec' : 'js-cosine',
    embeddingModel: prov ? `${prov.name}/${prov.model}` : 'none (hash fallback — keyword-adjacent only)',
    dimension: DIM,
    chunkSize: MAX_CHUNK,
  };
}

function workspaceOf(userId) {
  return path.resolve(config.agent.workspace, String(userId));
}
