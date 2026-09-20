// language: JavaScript (Node 20+ ESM), file: src/agent/workspace.js
// Per-user workspace isolation.
//
// Before this, every /agent turn ran in one shared directory. Two users on the
// same bot shared a workspace — one could read the other's files, and a
// write_file from chat A could clobber chat B. This resolves a workspace per
// user under the configured root and refuses any path that escapes it.
//
// Layout: <AGENT_WORKSPACE>/<userId>/   — created on first use, never shared.

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
 * Resolve a path against a user's workspace, rejecting escapes.
 * @returns {{ok: true, abs: string} | {ok: false, reason: string}}
 */
export function resolveInWorkspace(userId, rel) {
  const root = workspaceFor(userId);
  const abs = path.resolve(root, rel || '.');
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return { ok: false, reason: `path escapes the workspace (${rel})` };
  }
  return { ok: true, abs };
}

/** Free the cache entry after a workspace is wiped. */
export function forgetWorkspace(userId) {
  _cache.delete(String(userId ?? '0'));
}
