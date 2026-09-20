// language: JavaScript (Node 20+ ESM), file: src/bot/commands/usage.js
// /usage and /quota — cost tracking and per-user spend limits.
//
// Without a quota, one user on a free-tier key can burn the operator's whole
// budget before anyone notices. Usage was recorded but never surfaced or
// enforced; this closes that loop.

import { db, recordUsage, stats } from '../../db.js';
import { config } from '../../config.js';
import { isAdmin } from '../../config.js';

const DAILY_DEFAULT = Number(process.env.QUOTA_DAILY_TOKENS || 500_000);

function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Sum tokens for a user over a window ending now. */
export function tokensInWindow(userId, sinceMs) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(total_tokens), 0) AS s, COUNT(*) AS n
    FROM usage WHERE user_id = ? AND created_at >= ?
  `).get(userId, sinceMs);
  return { tokens: row.s, calls: row.n };
}

export function remainingQuota(userId) {
  const limit = quotaFor(userId);
  if (!limit) return null; // no limit configured
  const { tokens } = tokensInWindow(userId, todayStart());
  return Math.max(0, limit - tokens);
}

function quotaFor(userId) {
  // per-user override first, then the global default. 0 = unlimited.
  const row = db.prepare('SELECT quota_daily FROM user_quota WHERE user_id = ?').get(userId);
  if (row) return row.quota_daily;
  return DAILY_DEFAULT;
}

export function setQuota(userId, tokens) {
  db.prepare(`
    INSERT INTO user_quota (user_id, quota_daily, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET quota_daily = excluded.quota_daily, updated_at = excluded.updated_at
  `).run(userId, tokens, Date.now());
}

export async function usageCommand(ctx) {
  const uid = ctx.from.id;
  const day = tokensInWindow(uid, todayStart());
  const week = tokensInWindow(uid, Date.now() - 7 * 864e5);
  const total = db.prepare('SELECT COALESCE(SUM(total_tokens),0) AS s FROM usage WHERE user_id = ?').get(uid).s;
  const left = remainingQuota(uid);
  const limitTxt = left == null ? '∞ (no quota set)' : `${left.toLocaleString()} left of ${quotaFor(uid).toLocaleString()}/day`;

  // breakdown by model — this is what shows which model is actually expensive
  const byModel = db.prepare(`
    SELECT model, COUNT(*) AS n, COALESCE(SUM(total_tokens),0) AS s
    FROM usage WHERE user_id = ? AND created_at >= ?
    GROUP BY model ORDER BY s DESC LIMIT 6
  `).all(uid, Date.now() - 7 * 864e5);

  const lines = byModel.map((m) => `  • \`${m.model}\` — ${m.s.toLocaleString()} tok / ${m.n} calls`);

  await ctx.reply(
`📊 *Your usage*

*24h:* ${day.tokens.toLocaleString()} tokens (${day.calls} calls)
*7d:* ${week.tokens.toLocaleString()} tokens
*All time:* ${total.toLocaleString()} tokens
*Quota:* ${limitTxt}

*By model (7d):*
${lines.join('\n') || '  (none yet)'}`,
    { parse_mode: 'Markdown' },
  );
}

export async function quotaCommand(ctx) {
  if (!isAdmin(ctx.from.id)) return ctx.reply('🚫 Admin only.');
  const arg = (ctx.match || '').trim();
  if (!arg) {
    const g = db.prepare('SELECT user_id, quota_daily FROM user_quota ORDER BY updated_at DESC LIMIT 20').all();
    const body = g.map((q) => `  • \`${q.user_id}\` — ${q.quota_daily.toLocaleString()}/day`).join('\n');
    return ctx.reply(
`*Per-user daily token quotas* (global default: ${DAILY_DEFAULT.toLocaleString()})

${body || '(no per-user overrides — everyone is on the default)'}

Set one: \`/quota <userId> <tokens>\` — use 0 for unlimited.`,
      { parse_mode: 'Markdown' },
    );
  }
  const [uidStr, tokStr] = arg.split(/\s+/);
  const uid = Number(uidStr);
  const tokens = Number(tokStr);
  if (!Number.isFinite(uid) || !Number.isFinite(tokens) || tokens < 0) {
    return ctx.reply('Usage: `/quota <userId> <tokens>` (0 = unlimited)', { parse_mode: 'Markdown' });
  }
  setQuota(uid, tokens);
  await ctx.reply(`✅ \`${uid}\` daily quota set to ${tokens === 0 ? 'unlimited' : tokens.toLocaleString()} tokens.`, { parse_mode: 'Markdown' });
}

// The table is created lazily here rather than in db.js: quota is an operator
// concern, and a missing table on an old install should not stop the bot.
db.exec(`CREATE TABLE IF NOT EXISTS user_quota (
  user_id     INTEGER PRIMARY KEY,
  quota_daily INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);`);
