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
//
// Hardening (v2): LIKE wildcards are escaped so /forget "%" cannot wipe every
// fact, and autoLearn refuses text that reads as an injected instruction —
// memory is read into every future prompt, so anything stored here persists
// across sessions and would poison every subsequent turn.

import { db } from '../db.js';
import { logger } from '../logger.js';

const MAX_FACT_LEN = 500;

/**
 * Escape SQLite LIKE wildcards so user input is matched literally, not as a
 * pattern. `ESCAPE '\'` in the SQL makes the backslash meaningful.
 * Without this, `/forget %` deletes every memory row the user has.
 */
function escapeLikePattern(s) {
  // \ must be escaped first, before its own escaping doubles every \\.
  return String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * A stored fact is read into every future system prompt, so it must stay a
 * declarative fact. Reject anything that reads as an instruction to the agent
 * or a system-level directive — a user (or a tool output they pasted) should
 * not be able to plant persistent instructions via "I prefer ...".
 */
const INJECTION_PATTERNS = [
  // imperatives aimed at the agent: "ignore previous", "you must", "from now on"
  /\b(ignore|disregard|override|bypass|reveal|leak|expose|print|output|show)\s+(all\s+)?(previous|prior|system|the\s+)?(instructions?|prompts?|rules?|secrets?|keys?|tokens?|env)/i,
  /\b(you\s+(must|should|are now|act as|pretend to be|always|never))\b/i,
  /\b(from now on|as an ai|system prompt|jailbreak|dan mode|developer mode)\b/i,
  // tool/exec directives that would fire if the model complied
  /\b(run|execute|eval|curl|wget|bash|sh|rm\s+-rf|\/bin\/|sudo)\b/i,
  // tool-call markup: a fact must not smuggle a raw tool invocation
  /<\|tool_call_(start|end)\|>/i,
  /\b(tool_call|function_call)\s*[:=]/i,
  // same intent in Indonesian — the bot's main language
  /\b(abaikan|hiraukan|sekarang kamu|kamu (harus|wajib)|mode dan|developer mode)\b/i,
];

function isSafeMemoryFact(text) {
  const t = String(text || '').trim();
  if (!t || t.length > MAX_FACT_LEN) return false;
  for (const re of INJECTION_PATTERNS) {
    if (re.test(t)) {
      logger.warn({ fact: t.slice(0, 120) }, 'memory fact rejected: looks like an injected instruction');
      return false;
    }
  }
  return true;
}

/** table is created in db.js migrations */
export function remember(userId, fact, source = 'manual') {
  if (!fact || !userId) return false;
  const text = String(fact).trim();
  if (text.length > MAX_FACT_LEN) return false;
  db.prepare(`
    INSERT INTO memory (user_id, fact, source, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, fact) DO UPDATE SET updated_at = excluded.updated_at
  `).run(userId, text, source, Date.now());
  return true;
}

export function forget(userId, fact) {
  // Literal match only: % and _ are escaped, so the pattern cannot swallow the
  // whole table. `ESCAPE '\'` activates the backslash escapes in SQLite.
  const r = db.prepare(
    'DELETE FROM memory WHERE user_id = ? AND fact LIKE ? ESCAPE \'\\\'',
  ).run(userId, `%${escapeLikePattern(fact)}%`);
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

/**
 * Auto-learn: pull durable-looking facts out of a turn. Heuristic, opt-in.
 * The sentence is validated before storage — a tool output or pasted text
 * containing "I prefer you to always run rm -rf" must not become a permanent
 * system-prompt fixture.
 */
export function autoLearn(userId, userText, assistantText) {
  // a "preference declaration" is the strongest signal: "I prefer X", "I use X",
  // "my X is", "jangan X", "aku suka X" — Indonesian and English both
  const RE = /\b(?:i (?:prefer|use|work with|like|am))\b|\b(?:aku(?: suka| pakai| kerja)?)\b|\b(?:prefers?|standing)\b/i;
  if (!RE.test(userText)) return null;
  const sentence = userText.split(/[.\n]/).find((s) => RE.test(s))?.trim();
  if (!sentence || sentence.length > 300) return null;
  if (!isSafeMemoryFact(sentence)) return null; // injection-shaped → drop, don't store
  remember(userId, sentence.slice(0, 300), 'auto');
  logger.info({ userId }, 'memory fact auto-learned');
  return sentence;
}

// exported for tests
export { isSafeMemoryFact, escapeLikePattern };
