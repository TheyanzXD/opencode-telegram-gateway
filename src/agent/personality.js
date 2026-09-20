// language: JavaScript (Node 20+ ESM), file: src/agent/personality.js
// /soul.md — a user-editable personality file, injected as the base system prompt.
//
// The system prompt was hard-coded. Every bot on this gateway answered the same
// way. The soul file is the fix: one markdown file per user, loaded at the top
// of the prompt cache, so changing a personality does not mean editing source.
//
// Placement matters. It goes ABOVE the runtime context and below nothing — it
// is the deepest, highest-priority instruction the model receives. Everything
// the bot says inherits its tone before any skill or memory is consulted.

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { workspaceFor } from './workspace.js';

const SOUL_FILE = process.env.SOUL_FILE || 'soul.md';
const DEFAULT_SOUL = `# Soul

You are the operator's gateway assistant. You answer plainly and directly.
You are helpful, precise, and you do not pad. When you do not know, you say so.
You follow the user's language: reply in the language they wrote in.`;

/** A per-user soul, falling back to the shared one. Never throws. */
export async function loadSoul(userId) {
  const candidates = userId
    ? [path.join(workspaceFor(userId), SOUL_FILE), path.join(config.agent.workspace, SOUL_FILE), SOUL_FILE]
    : [path.join(config.agent.workspace, SOUL_FILE), SOUL_FILE];

  for (const p of candidates) {
    try {
      const stat = await fs.stat(p);
      if (!stat.isFile()) continue;
      const text = await fs.readFile(p, 'utf8');
      if (text.trim().length < 8) continue;
      return { text: text.trim(), path: p };
    } catch {
      // absent or unreadable — the fallback is still a valid personality
    }
  }
  return { text: DEFAULT_SOUL, path: null };
}

/**
 * The soul as a system message. It is returned on its own so the caller can
 * splice it into the cached prefix rather than into the volatile tail.
 */
export async function soulMessage(userId) {
  const { text, path: from } = await loadSoul(userId);
  if (from) logger.debug({ soul: from }, 'personality loaded');
  return { role: 'system', content: text };
}

/** Where the soul for this user lives, for /soul commands to show. */
export function soulPathFor(userId) {
  return path.join(workspaceFor(userId), SOUL_FILE);
}

export { SOUL_FILE, DEFAULT_SOUL };
