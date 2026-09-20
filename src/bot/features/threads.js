// language: JavaScript (Node 20+ ESM), file: src/bot/features/threads.js
// Reply chains, regenerate, stop generation, session expiry, conversation export.
//
// Telegram threads a conversation through reply targets. The bot ignored that:
// a reply to an old message carried no context, and the only way to redo an
// answer was to retype the whole prompt. These four hooks close that gap.

import { db, getHistory, clearHistory, addMessage } from '../../db.js';
import { logger } from '../../logger.js';
import { config } from '../../config.js';
import { splitLong, toTelegramMarkdown } from '../../format.js';

const SESSION_TTL_MS = (Number(process.env.SESSION_TTL_DAYS || 30)) * 864e5;
const STOP_PREFIX = 'stop:';
const REGEN_PREFIX = 'regen:';

// --------------------------------------------------------------- reply context

/**
 * When a user replies to a message, pull the surrounding turns into context.
 * Telegram gives us the replied message; we widen it to its neighbors so a
 * reply to one line of a longer exchange still sees the exchange.
 *
 * @returns {Array<{role:string, content:string}> | null}
 */
export function replyContext(ctx, sessionId) {
  const target = ctx.message?.reply_to_message;
  if (!target) return null;
  const userId = ctx.from.id;
  const hist = getHistory(userId, 200, sessionId);
  if (!hist.length) return null;

  const needle = String(target.text || target.caption || '').trim();
  if (needle.length < 8) return null; // "ok" is not enough to match on

  // Find the message closest to what was replied to, by text similarity —
  // Telegram does not hand us the row id, only the content.
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < hist.length; i++) {
    const score = similarity(needle, String(hist[i].content || ''));
    if (score > bestScore) { bestScore = score; best = i; }
  }
  if (best < 0 || bestScore < 0.5) return null;

  const start = Math.max(0, best - 6);
  const slice = hist.slice(start, best + 4);
  return slice
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: String(m.content) }));
}

function similarity(a, b) {
  if (!a || !b) return 0;
  const A = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const B = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / Math.min(A.size, B.size);
}

// --------------------------------------------------------------- regenerate

/** The message the bot would regenerate from, keyed by reply target. */
const _lastAnswer = new Map(); // message_id → {prompt, media}

export function rememberAnswer(chatId, botMessageId, prompt, media = []) {
  if (!botMessageId) return;
  _lastAnswer.set(`${chatId}:${botMessageId}`, { prompt, media });
  // The map is per-message and unbounded in a long chat; keep it small.
  if (_lastAnswer.size > 200) {
    const first = _lastAnswer.keys().next().value;
    _lastAnswer.delete(first);
  }
}

export function getAnswerFor(chatId, botMessageId) {
  return _lastAnswer.get(`${chatId}:${botMessageId}`) || null;
}

export function regenKeyboard(botMessageId) {
  return {
    inline_keyboard: [[
      { text: '↻ Regenerate', callback_data: `${REGEN_PREFIX}${botMessageId}` },
    ]],
  };
}

export async function regenCallback(ctx) {
  const key = ctx.callbackQuery.data.slice(REGEN_PREFIX.length);
  const entry = _lastAnswer.get(`${ctx.chat.id}:${key}`);
  if (!entry) {
    return ctx.answerCallbackQuery({ text: 'That message is too old to regenerate.' });
  }
  await ctx.answerCallbackQuery({ text: 'Regenerating…' });
  // Re-enter the normal prompt path with the stored prompt and media.
  const { handlePrompt } = await import('../handlers/message.js');
  await handlePrompt(ctx, entry.prompt, entry.media);
}

// --------------------------------------------------------------- stop

const _abortControllers = new Map(); // chatId → AbortController

export function abortControllerFor(chatId) {
  let ac = _abortControllers.get(chatId);
  if (!ac) {
    ac = new AbortController();
    _abortControllers.set(chatId, ac);
  }
  return ac;
}

export function releaseAbortController(chatId) {
  _abortControllers.delete(chatId);
}

export function stopKeyboard() {
  return { inline_keyboard: [[{ text: '⏹ Stop', callback_data: `${STOP_PREFIX}1` }]] };
}

export async function stopCallback(ctx) {
  const ac = _abortControllers.get(ctx.chat.id);
  if (ac && !ac.signal.aborted) {
    ac.abort();
    await ctx.answerCallbackQuery({ text: 'Generation stopped.' });
    return;
  }
  await ctx.answerCallbackQuery({ text: 'Nothing to stop.' });
}

export const stopPrefix = STOP_PREFIX;
export const regenPrefix = REGEN_PREFIX;

// --------------------------------------------------------------- session expiry

/**
 * Forget history older than the TTL. A conversation from six months ago is not
 * context — it is noise that fills the window and costs tokens every turn.
 * Called once at startup and then on an interval.
 */
export function expireOldSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  try {
    const r = db.prepare('DELETE FROM messages WHERE created_at < ?').run(cutoff);
    if (r.changes) logger.info({ deleted: r.changes, ttlDays: SESSION_TTL_MS / 864e5 }, 'expired old history');
  } catch (err) {
    logger.warn({ err: err.message }, 'session expiry failed');
  }
}

// --------------------------------------------------------------- export

export async function exportConversation(ctx, sessionId) {
  const userId = ctx.from.id;
  const rows = sessionId
    ? db.prepare('SELECT role, content, created_at FROM messages WHERE user_id = ? AND session_id = ? ORDER BY id ASC').all(userId, sessionId)
    : db.prepare('SELECT role, content, created_at FROM messages WHERE user_id = ? ORDER BY id ASC LIMIT 500').all(userId);

  if (!rows.length) return ctx.reply('Nothing to export — this session is empty.');

  const md = rows.map((r) => {
    const when = new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 16);
    const who = r.role === 'user' ? '👤 User' : r.role === 'assistant' ? '🤖 Assistant' : '🧠 System';
    return `## ${who} — ${when}\n\n${String(r.content || '').trim()}\n`;
  }).join('\n---\n\n');

  const head = `# Conversation export\nUser: ${userId} · Session: ${sessionId || 'default'} · Exported: ${new Date().toISOString()}\n`;
  const json = JSON.stringify({ user_id: userId, session_id: sessionId, exported_at: Date.now(), messages: rows }, null, 2);

  await ctx.replyWithDocument(
    { source: Buffer.from(head + md), filename: 'conversation.md' },
    { caption: 'Conversation export (Markdown)' },
  ).catch(async () => {
    // Documents can fail on long content; fall back to sending it as text.
    for (const chunk of splitLong(md)) {
      await ctx.reply(chunk).catch(() => {});
    }
  });

  await ctx.replyWithDocument(
    { source: Buffer.from(json), filename: 'conversation.json' },
    { caption: 'Conversation export (JSON, re-importable)' },
  ).catch(() => {});
}


