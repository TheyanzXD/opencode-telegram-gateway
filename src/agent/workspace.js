// language: JavaScript (Node 20+ ESM), file: src/agent/workspace.js
// Per-user workspace isolation.
//
// Before this, every /agent turn ran in one shared directory. Two users on the
// same bot shared a workspace — one could read the other's files, and a
// write_file from chat A could clobber chat B. This resolves a workspace per
// user under the configured root and refuses any path that escapes it.
//
// Layout: <AGENT_WORKSPACE>/<userId>/   — created on first use, never shared.
//
// Hardening (v2): the escape check uses canonical paths (realpathSync +
// path.relative) instead of startsWith. `startsWith` accepted
// /root/workspace-sensitive for root /root/workspace, and a symlink inside the
// workspace could point anywhere on the host. realpath resolves both.

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';

const _cache = new Map(); // userId → absolute dir

/**
 * Absolute workspace directory for a user. Created on first call.
 * @param {number|string} userId
 * @returns {string}
 */
export function workspaceFor(userId) {
  const key = String(userId ?? '0');
  if (_cache.has(key)) return _cache.get(key);

  const root = config.agent?.workspace;
  if (!root) throw new Error('agent.workspace is not configured');
  const dir = path.resolve(root, key);

  // A user ID is numeric, so this can never traverse: ../ in a numeric key is
  // impossible. Guard anyway — defense in depth costs four lines.
  if (!dir.startsWith(path.resolve(root))) {
    throw new Error(`workspace path escapes root for user ${key}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  _cache.set(key, dir);
  return dir;
}

/**
 * Resolve a path against a base directory, rejecting escapes using CANONICAL
 * paths. This is the jail every filesystem-touching tool must pass through.
 *
 * Why not startsWith: "/root/workspace-sensitive" starts with "/root/workspace"
 * as a raw string, but is a different tree. And a symlink inside the workspace
 * pointing at /etc passes a raw string check too. realpathSync resolves both
 * the base and the target to their true on-disk locations first.
 *
 * For a path that does not exist yet (a file about to be written), the PARENT
 * directory is resolved instead — the file will be created inside it, so the
 * parent must already be inside the jail.
 *
 * @param {string} baseWorkspace absolute base (already resolved)
 * @param {string} requestedPath path relative to base, or absolute inside base
 * @returns {string} the resolved absolute path, inside the jail
 * @throws {Error} if the path resolves outside baseWorkspace
 */
export function assertPathInJail(baseWorkspace, requestedPath) {
  const realBase = fs.realpathSync(path.resolve(baseWorkspace));
  const resolvedTarget = path.resolve(realBase, requestedPath || '.');

  if (fs.existsSync(resolvedTarget)) {
    const realTarget = fs.realpathSync(resolvedTarget);
    const rel = path.relative(realBase, realTarget);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('Akses ditolak: Operasi berada di luar batas workspace sandbox.');
    }
    return realTarget;
  }

  // File-to-be-created: the parent must exist and be inside the jail. A
  // nonexistent parent is refused rather than created — mkdir-p from a tool
  // argument is how a path traversal writes outside the jail.
  const parent = path.dirname(resolvedTarget);
  if (!fs.existsSync(parent)) {
    throw new Error('Direktori induk tidak ditemukan.');
  }
  const realParent = fs.realpathSync(parent);
  const rel = path.relative(realBase, realParent);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Akses ditolak: Operasi berada di luar batas workspace sandbox.');
  }
  return resolvedTarget;
}

/**
 * Resolve a path against a user's workspace, rejecting escapes.
 * @returns {{ok: true, abs: string} | {ok: false, reason: string}}
 */
export function resolveInWorkspace(userId, rel) {
  const root = workspaceFor(userId);
  try {
    return { ok: true, abs: assertPathInJail(root, rel) };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/** Free the cache entry after a workspace is wiped. */
export function forgetWorkspace(userId) {
  _cache.delete(String(userId ?? '0'));
}
