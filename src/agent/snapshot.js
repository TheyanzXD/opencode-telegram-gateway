// language: JavaScript (Node 20+ ESM), file: src/agent/snapshot.js
// Undo for agent edits. Every mutating tool snapshots the file first; /undo
// restores it in reverse chronological order.
//
// Why a ring per user, not infinite history: a long agentic run makes hundreds
// of edits. Keeping all of them costs disk and, worse, /undo becomes a lottery
// — the user taps it ten times hoping to land before the mistake. A bounded
// ring of the most recent edits makes /undo mean "the last thing you changed,"
// which is the only promise the word can keep.

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const RING_SIZE = 40;

// user_id -> [{ file, hash, takenAt, bytes }]
const _rings = new Map();

function ringOf(userId) {
  const key = String(userId ?? '0');
  if (!_rings.has(key)) _rings.set(key, []);
  return _rings.get(key);
}

/** The absolute path a workspace-relative (or absolute) file refers to. */
function resolveTo(filePath, userId) {
  const root = path.resolve(config.root, 'workspace', String(userId));
  return path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
}

/** True when the path is inside this user's workspace. */
function insideWorkspace(filePath, userId) {
  try {
    const root = path.resolve(config.root, 'workspace', String(userId));
    const abs = resolveTo(filePath, userId);
    return abs === root || abs.startsWith(root + path.sep);
  } catch {
    return false;
  }
}

function hashOf(buf) {
  // FNV-1a, 32-bit. Not cryptographic — it only answers "did the file change
  // between two snapshots," and it has to be fast enough to run before every
  // write.
  let h = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Take a snapshot of a file before it changes. Called by the mutating tools.
 * Returns true when a snapshot was actually recorded.
 */
export function snapshot(filePath, userId) {
  if (!insideWorkspace(filePath, userId)) return false;
  let buf;
  try {
    buf = fs.readFileSync(resolveTo(filePath, userId));
  } catch (err) {
    // ENOENT: the file is new, nothing to snapshot. The undo for a create is
    // a delete, which is recorded as a null hash.
    if (err.code === 'ENOENT') {
      push(userId, { file: filePath, hash: null, takenAt: Date.now(), bytes: 0 });
      return true;
    }
    return false;
  }
  push(userId, { file: filePath, hash: hashOf(buf), takenAt: Date.now(), bytes: buf.length });
  return true;
}

function push(userId, entry) {
  const ring = ringOf(userId);
  ring.push(entry);
  // Drop the oldest beyond the ring. The alternative — unbounded growth —
  // means /undo stops being a meaningful action.
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
}

/**
 * Undo the last change by this user. Restores the file to its prior bytes, or
 * deletes it when the change was a creation.
 */
export function undo(userId) {
  const ring = ringOf(userId);
  if (!ring.length) return { ok: false, reason: 'nothing to undo' };

  const entry = ring.pop();
  const root = path.resolve(config.root, 'workspace', String(userId));
  const abs = resolveTo(entry.file, userId);

  // A null hash means the file did not exist before this change: undo = remove.
  if (entry.hash === null) {
    try { fs.unlinkSync(abs); } catch (err) { if (err.code !== 'ENOENT') return { ok: false, reason: err.message }; }
    return { ok: true, message: `removed ${entry.file} (it was created by the last edit)` };
  }

  // The snapshot holds the pre-change hash; the bytes it refers to were
  // stashed on disk under that hash by stashOriginal(). Restore from there.
  // entry.hash === null means the file did not exist — handled above.
  const source = path.resolve(root, '.undo', `${entry.hash}.bin`);

  if (fs.existsSync(source)) {
    try {
      fs.copyFileSync(source, abs);
      return { ok: true, message: `restored ${entry.file} to its state before the last edit` };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  // The .undo entry rotated out of the ring, or the stash failed. Either way,
  // say what is true instead of deleting the current file.
  return { ok: false, reason: `the previous state of ${entry.file} is no longer recoverable` };
}

/** How many undos are available. */
export function undoDepth(userId) {
  return ringOf(userId).length;
}

/**
 * Persist a pre-change copy so undo can reach it after the ring rotates.
 * Called by the mutating tools right after snapshot().
 */
export function stashOriginal(filePath, userId) {
  if (!insideWorkspace(filePath, userId)) return false;
  let buf;
  try { buf = fs.readFileSync(resolveTo(filePath, userId)); } catch { return false; }
  const root = path.resolve(config.root, 'workspace', String(userId));
  const dir = path.join(root, '.undo');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  try { fs.writeFileSync(path.join(dir, `${hashOf(buf)}.bin`), buf); } catch { return false; }
  return true;
}
