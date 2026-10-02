import { getUser, usageByUser } from '../../db.js';
import { messageStats, auditStats } from '../../tenant_messages.js';
import { memoryStats } from '../../memory.js';

function escMd(s) { return String(s ?? '').replace(/[_*[`]/g, '\\$&'); }

function fmt(n) { return n?.toLocaleString?.() ?? String(n ?? 0); }

function rangeKb(days) {
  const labels = { 7: 'Last 7 days', 30: 'Last 30 days', 0: 'All time' };
  return labels[days] || `Last ${days}d`;
}

export async function statsCommand(ctx) {
  const arg = parseInt((ctx.match || '').trim(), 10);
  const days = Number.isFinite(arg) && arg > 0 ? arg : 30;
  const u = getUser(ctx.from.id);
  if (!u) return ctx.reply('No data yet.');
  const since = days === 0 ? 0 : Date.now() - days * 86400_000;

  const msg = messageStats(u.user_id);
  const tools = auditStats(u.user_id, { since });
  const usage = usageByUser(u.user_id, days === 0 ? 365 * 100 : days);
  const mem = memoryStats(u.user_id);

  const lines = [];
  lines.push(`📊 *stats* — ${escMd(rangeKb(days === 0 ? 0 : days))}`);
  lines.push(`Messages: *${fmt(msg.total_messages)}* total · *${fmt(msg.last30_messages)}* last 30d`);
  lines.push(`Sessions: *${fmt(msg.sessions)}* · Memory chunks: *${fmt(mem.total)}* (${fmt(mem.last7)} new / 7d)`);
  lines.push('');
  lines.push('*Provider usage*');
  if (!usage.length) lines.push('_none yet_');
  else for (const r of usage.slice(0, 6)) {
    lines.push(`• \`${escMd(r.provider)}/${escMd(r.model)}\` — ${fmt(r.total_tokens)} toks, ${fmt(r.calls)} calls`);
  }
  lines.push('');
  lines.push('*Tool calls*');
  if (!tools.length) lines.push('_none yet_');
  else for (const t of tools.slice(0, 8)) {
    lines.push(`• \`${escMd(t.tool_name)}\` — ${fmt(t.n)} (${fmt(t.ok_n)} ok)`);
  }

  lines.push('', { reply_markup: {
    inline_keyboard: [[
      { text: '7d',  callback_data: 'stats:7' },
      { text: '30d', callback_data: 'stats:30' },
      { text: 'All', callback_data: 'stats:0' },
    ]],
  } });

  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
}

export async function statsCallback(ctx) {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith('stats:')) return ctx.answerCallbackQuery().catch(() => {});
  const days = parseInt(data.slice('stats:'.length), 10);
  await ctx.answerCallbackQuery().catch(() => {});
  // re-render with new range
  ctx.match = String(days);
  return statsCommand(ctx);
}