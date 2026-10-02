// language: JavaScript (Node 20+ ESM), file: src/bot/features/pinned.js
// Pinning important turns + full-text search over history.
//
// /history shows the last N messages in order. A pinned turn is one the user
// marked as load-bearing — an instruction, a spec, a decision — and pinning
// means it survives the compression window and can be pulled by search
// instead of by scrolling.

import { db } from '../../db.js';

db.exec(`CREATE TABLE IF NOT EXISTS pinned (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  message_id INTEGER NOT NULL,         -- the user's telegram message id
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  note       TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, message_id, role)
);`);

db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  user_id, session_id, role, content,
  content='messages',
  content_rowid='id',
  tokenize='unicode61'
);`);

// Keep the FTS index in sync with the messages table.
db.exec(`CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, user_id, session_id, role, content)
  VALUES (new.id, CAST(new.user_id AS TEXT), CAST(new.session_id AS TEXT), new.role, new.content);
END;`);

db.exec(`CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, user_id, session_id, role, content)
  VALUES ('delete', old.id, CAST(old.user_id AS TEXT), CAST(old.session_id AS TEXT), old.role, old.content);
END;`);

/**
 * Pin a turn. Called from a reply-with-`/pin` flow or the command itself.
 * A pin is a claim that this turn matters later — it is excluded from
 * compression and always returned by search.
 */
export function pinTurn(userId, messageId, role, content, note = '') {
  db.prepare(`
    INSERT INTO pinned (user_id, message_id, role, content, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, message_id, role) DO UPDATE SET
      content = excluded.content, note = excluded.note, created_at = excluded.created_at
  `).run(userId, messageId, role, content, note, Date.now());
  return true;
}

export function unpinTurn(userId, messageId) {
  return db.prepare('DELETE FROM pinned WHERE user_id = ? AND message_id = ?').run(userId, messageId).changes > 0;
}

export function listPins(userId, limit = 30) {
  return db.prepare('SELECT * FROM pinned WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit);
}

/**
 * Full-text search across a user's history AND their pins.
 *
 * @returns {Array<{role, content, source, message_id}>}
 */
export function searchHistory(userId, query, limit = 12) {
  // fts5 cannot combine a MATCH with a column filter in the WHERE clause, so
  // match first and narrow by user in memory.
  const rows = db.prepare(`
    SELECT user_id, role, content FROM messages_fts
    WHERE messages_fts MATCH ?
    ORDER BY rank LIMIT 200
  `).all(sanitizeFts(query));

  const fts = rows
    .filter((r) => String(r.user_id) === String(userId))
    .slice(0, limit)
    .map((r) => ({ role: r.role, content: r.content, source: 'history' }));

  const pins = db.prepare(`
    SELECT role, content, note, message_id FROM pinned WHERE user_id = ?
    AND (content LIKE ? OR note LIKE ?)
    ORDER BY created_at DESC LIMIT ?
  `).all(userId, `%${likeEsc(query)}%`, `%${likeEsc(query)}%`, limit);

  return [
    ...fts.map((r) => ({ role: r.role, content: r.content, source: 'history' })),
    ...pins.map((r) => ({ role: r.role, content: r.content, source: 'pin', message_id: r.message_id })),
  ];
}

// fts5 treats : " * ( ) as operators — strip them so plain user text works.
function sanitizeFts(q) {
  return String(q || '')
    .replace(/["*:()^]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .map((w) => w + '*') // prefix matching: "auth" finds "authentication"
    .join(' ') || '""';
}

function likeEsc(s) {
  return String(s || '').replace(/[%_]/g, (c) => '\\' + c);
}

/** Pinned content, as extra context injected under the cached prefix. */
export function pinnedBlock(userId, limit = 6) {
  const rows = listPins(userId, limit);
  if (!rows.length) return '';
  const body = rows
    .map((r, i) => `${i + 1}. [${r.role}] ${String(r.content).trim().slice(0, 500)}${r.note ? `\n   note: ${r.note}` : ''}`)
    .join('\n');
  return `# Pinned by the user — these are load-bearing, keep them in mind:\n\n${body}`;
}
