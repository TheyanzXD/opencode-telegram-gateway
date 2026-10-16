// language: JavaScript (Node 20+ ESM), file: src/bot/commands/xerj.js
// /xerj — control and query the local XERJ AI search and indexing engine.
// Supports: /xerj search <query>, /xerj def <symbol>, /xerj index [dir], /xerj status, /xerj gain

import { xerjSearch, xerjDef, xerjAutoindex, xerjStatus, xerjGain, isXerjRunning } from '../../agent/xerj.js';

const MD = { parse_mode: 'Markdown' };

export async function xerjCommand(ctx) {
  const text = (ctx.match || '').trim();
  const [sub, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ').trim();

  if (!sub || sub === 'help') {
    const online = await isXerjRunning();
    return ctx.reply(
      [
        `⚡ *XERJ AI Code Search & Indexer* [${online ? '🟢 Online' : '🔴 Offline'}]`,
        '',
        'Token-efficient local search engine for AI agents (2.7x–40x fewer tokens).',
        '',
        '*Commands:*',
        '• `/xerj search <text>` — Search code passages with file:line citations',
        '• `/xerj def <symbol>` — Find where a symbol is defined (signature & file:line)',
        '• `/xerj index [folder]` — Auto-index a folder or workspace (default: current workspace)',
        '• `/xerj gain` — View measured token savings and query latency',
        '• `/xerj status` — Check engine cluster health and indexed indices',
      ].join('\n'),
      MD
    );
  }

  if (sub === 'status') {
    const st = await xerjStatus();
    if (!st.ok) {
      return ctx.reply(`🔴 *XERJ Status:* Offline\nError: ${st.error || 'Server not reachable'}`, MD);
    }
    const lines = [
      '🟢 *XERJ Engine Status*',
      `• Cluster: \`${st.cluster_name}\` (${st.status})`,
      `• URL: \`${st.url}\``,
      `• Indexed Datasets: ${st.indices?.length || 0}`,
    ];
    if (st.indices?.length) {
      lines.push('');
      for (const idx of st.indices) {
        lines.push(`  - \`${idx.index}\`: ${idx.docs_count} docs (${idx.store_size})`);
      }
    }
    return ctx.reply(lines.join('\n'), MD);
  }

  if (sub === 'gain') {
    await ctx.api.sendChatAction(ctx.chat.id, 'typing');
    const g = await xerjGain();
    if (!g.ok) return ctx.reply(`❌ *XERJ Gain Error:* ${g.error}`, MD);
    return ctx.reply(`📊 *XERJ Token Gain & Metrics:*\n\n\`\`\`\n${g.output}\n\`\`\``, MD);
  }

  if (sub === 'search') {
    if (!arg) return ctx.reply('Usage: `/xerj search <function, symbol or phrase>`', MD);
    await ctx.api.sendChatAction(ctx.chat.id, 'typing');
    const res = await xerjSearch(arg);
    if (!res.ok) return ctx.reply(`❌ *Search Failed:* ${res.error}`, MD);
    const body = res.output ? res.output.slice(0, 3900) : '(no matches found)';
    return ctx.reply(`🔍 *XERJ Passage Search for* \`${arg}\`:\n\n${body}`, MD);
  }

  if (sub === 'def') {
    if (!arg) return ctx.reply('Usage: `/xerj def <symbolName>`', MD);
    await ctx.api.sendChatAction(ctx.chat.id, 'typing');
    const res = await xerjDef(arg);
    if (!res.ok) return ctx.reply(`❌ *Definition Lookup Failed:* ${res.error}`, MD);
    const body = res.output ? res.output.slice(0, 3900) : `(no definition found for ${arg})`;
    return ctx.reply(`📍 *XERJ Definition for* \`${arg}\`:\n\n${body}`, MD);
  }

  if (sub === 'index' || sub === 'autoindex') {
    const folder = arg || '.';
    await ctx.reply(`⏳ *Indexing* \`${folder}\` with XERJ… This may take a few seconds.`, MD);
    const res = await xerjAutoindex(folder);
    if (!res.ok) return ctx.reply(`❌ *Autoindex Failed:* ${res.error}`, MD);
    return ctx.reply(`✅ *XERJ Autoindex Complete!*\n\n\`\`\`\n${(res.output || '').slice(-2000)}\n\`\`\``, MD);
  }

  return ctx.reply(`Unknown subcommand \`${sub}\`. Send \`/xerj\` for help.`, MD);
}
