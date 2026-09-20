// language: JavaScript (Node 20+ ESM), file: src/agent/memory.js
// Cross-session memory — durable facts about a user, injected per turn.
//
// Not conversation history (that is in the messages table, and it expires).
// Memory is the small set of things that should survive a /reset and a new
// session: who the user is, their standing conventions, their environment.
//
// Rules carried over from Hermes:
// - memory is injected BELOW the cached prefix, as its own system message
// - memory is declarative facts, never instructions to the agent
// - one fact per row; stale facts are replaced, not appended

import { db } from '../db.js';
import { logger } from '../logger.js';

/** table is created in db.js migrations */
export function remember(userId, fact, source = 'manual') {
  if (!fact || !userId) return false;
  const text = String(fact).trim();
  if (text.length > 500) return false;
  db.prepare(`
    INSERT INTO memory (user_id, fact, source, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, fact) DO UPDATE SET updated_at = excluded.updated_at
  `).run(userId, text, source, Date.now());
  return true;
}

export function forget(userId, fact) {
  const r = db.prepare('DELETE FROM memory WHERE user_id = ? AND fact LIKE ?').run(userId, `%${fact}%`);
  return r.changes > 0;
}

export function recall(userId, limit = 20) {
  return db.prepare('SELECT fact FROM memory WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?')
    .all(userId, limit)
    .map((r) => r.fact);
}

/**
 * The system-prompt block. Declarative facts only — "User prefers concise
 * responses" is a fact; "Always respond concisely" would read as an order and
 * could override what the user actually asked for this turn.
 */
export function memoryBlock(userId) {
  const facts = recall(userId);
  if (!facts.length) return null;
  return `Facts you know about this user (from memory):\n${facts.map((f) => `- ${f}`).join('\n')}`;
}

/** Auto-learn: pull durable-looking facts out of a turn. Heuristic, opt-in. */
export function autoLearn(userId, userText, assistantText) {
  // a "preference declaration" is the strongest signal: "I prefer X", "I use X",
  // "my X is", "jangan X", "aku suka X" — Indonesian and English both
  const RE = /\b(?:i (?:prefer|use|work with|like|am))\b|\b(?:aku(?: suka| pakai| kerja)?)\b|\b(?:prefers?|standing)\b/i;
  if (!RE.test(userText)) return null;
  const sentence = userText.split(/[.\n]/).find((s) => RE.test(s))?.trim();
  if (!sentence || sentence.length > 300) return null;
  remember(userId, sentence.slice(0, 300), 'auto');
  logger.info({ userId }, 'memory fact auto-learned');
  return sentence;
}
