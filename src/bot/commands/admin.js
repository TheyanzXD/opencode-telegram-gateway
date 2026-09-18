import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import archiver from 'archiver';
import { providerNames, modelList, allModels, saveProviders } from '../../providers/store.js';
import { stats, setBanned, db, listSessions } from '../../db.js';
import { config } from '../../config.js';

export async function adminCommand(ctx) {
  // Gate: admin commands only allowed in the configured channel
  if (!ctx.state.isAdmin) return ctx.reply('🚫 Admin only.');
  if (!ctx.state.isAdminChannel) {
    return ctx.reply('🔒 Admin commands are restricted to the configured channel.');
  }
  const arg = (ctx.match || '').trim();
  if (!arg || arg === 'panel') return showPanel(ctx);
  const [sub, ...rest] = arg.split(/\s+/);
  if (sub === 'providers') return listProviders(ctx);
  if (sub === 'users') return listUsers(ctx);
  if (sub === 'ban' || sub === 'unban') return banUser(ctx, rest[0], sub === 'ban');
  if (sub === 'broadcast') return broadcast(ctx, rest.join(' '));
  if (sub === 'default') return setDefault(ctx, rest.join(' '));
  if (sub === 'export') return exportAll(ctx, rest.join(' '));
  return ctx.reply('Admin subcommands: panel, providers, users, ban <id>, unban <id>, broadcast <msg>, default <provider>/<model>, export [user_id]');
}

async function showPanel(ctx) {
  const s = stats();
  const proxy = db.prepare('SELECT COUNT(*) AS c FROM proxies').get().c;
  await ctx.reply(
`👮 *Admin Panel*
• Users: ${s.users}  (banned: ${s.banned})
• Messages: ${s.messages}  • Tokens: ${s.total_tokens}
• Proxies in pool: ${proxy}
• Providers: ${providerNames().join(', ')}
• Default model: \`${config.defaults.provider}/${config.defaults.model}\`
• Admin channel: \`${config.admin.channelId || '(any)'}\`
• Proxy mode: ${config.proxy.enabled ? `on (target ${config.proxy.target}, rotate ${config.proxy.rotatePerChat ? 'per chat' : 'global'})` : 'off'}

/admin providers — list providers + models
/admin users — recent users
/admin ban <user_id> / /admin unban <user_id>
/admin broadcast <text>
/admin default <provider>/<model>
/admin export [user_id]   — zip everything to home channel`,
    { parse_mode: 'Markdown' }
  );
}

async function listProviders(ctx) {
  const out = [];
  for (const p of providerNames()) {
    const meta = modelList(p);
    out.push(`\n*${p}* — ${meta.length} model(s)`);
    for (const m of meta.slice(0, 30)) {
      out.push(`  • ${m.id}${m.vision ? ' 🖼' : ''}`);
    }
    if (meta.length > 30) out.push(`  … +${meta.length - 30} more`);
  }
  await ctx.reply(out.join('\n') || 'No providers.', { parse_mode: 'Markdown' });
}

async function listUsers(ctx) {
  const rows = db.prepare('SELECT user_id, username, first_name, is_banned, provider, model FROM users ORDER BY updated_at DESC LIMIT 25').all();
  if (!rows.length) return ctx.reply('No users yet.');
  const out = rows.map((r) =>
    `• ${r.user_id}${r.is_banned ? ' 🚫' : ''} @${r.username || r.first_name || ''} → ${r.provider}/${r.model}`
  ).join('\n');
  await ctx.reply(out);
}

async function banUser(ctx, idStr, flag) {
  const id = parseInt(idStr, 10);
  if (!Number.isFinite(id)) return ctx.reply('Usage: /admin ban <user_id>');
  setBanned(id, flag);
  await ctx.reply(`${flag ? '🚫 Banned' : '✅ Unbanned'} ${id}`);
}

async function broadcast(ctx, text) {
  if (!text) return ctx.reply('Usage: /admin broadcast <text>');
  const rows = db.prepare('SELECT user_id FROM users WHERE is_banned = 0').all();
  let n = 0;
  for (const r of rows) {
    try { await ctx.api.sendMessage(r.user_id, text); n++; } catch { /* ignore blocked */ }
  }
  await ctx.reply(`📣 Broadcast sent to ${n}/${rows.length} user(s).`);
}

async function setDefault(ctx, arg) {
  const [provider, ...rest] = (arg || '').split('/');
  const model = rest.join('/');
  if (!provider || !model) return ctx.reply('Usage: /admin default <provider>/<model>');
  config.defaults.provider = provider;
  config.defaults.model = model;
  await ctx.reply(`✅ Default set to \`${provider}/${model}\` (process only — edit .env to persist)`);
}

async function exportAll(ctx, userArg) {
  const filterUser = userArg ? parseInt(userArg, 10) : null;
  const home = config.export.homeChannel;
  if (!home) return ctx.reply('⚠️ TELEGRAM_HOME_CHANNEL not set in .env — nothing to export to.');

  const tmp = path.join(os.tmpdir(), `gateway-export-${Date.now()}.zip`);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    const zip = archiver('zip', { zlib: { level: 9 } });
    out.on('close', resolve);
    zip.on('error', reject);
    zip.pipe(out);

    // users (optionally filtered)
    const users = filterUser
      ? db.prepare('SELECT * FROM users WHERE user_id = ?').all(filterUser)
      : db.prepare('SELECT * FROM users').all();
    zip.append(JSON.stringify(users, null, 2), { name: 'users.json' });

    // sessions
    const sessions = filterUser
      ? listSessions(filterUser)
      : db.prepare('SELECT * FROM sessions').all();
    zip.append(JSON.stringify(sessions, null, 2), { name: 'sessions.json' });

    // messages
    const messages = filterUser
      ? db.prepare('SELECT * FROM messages WHERE user_id = ? ORDER BY id ASC').all(filterUser)
      : db.prepare('SELECT * FROM messages ORDER BY id ASC').all();
    zip.append(JSON.stringify(messages, null, 2), { name: 'messages.json' });

    // usage
    const usage = filterUser
      ? db.prepare('SELECT * FROM usage WHERE user_id = ? ORDER BY id ASC').all(filterUser)
      : db.prepare('SELECT * FROM usage ORDER BY id ASC').all();
    zip.append(JSON.stringify(usage, null, 2), { name: 'usage.json' });

    // proxies
    const proxies = db.prepare('SELECT * FROM proxies').all();
    zip.append(JSON.stringify(proxies, null, 2), { name: 'proxies.json' });

    // config snapshot
    zip.append(JSON.stringify(config, null, 2), { name: 'config-snapshot.json' });

    // README inside zip
    zip.append(`OpenCode Gateway export\nGenerated: ${new Date().toISOString()}\nScope: ${filterUser ? `user ${filterUser}` : 'all data'}\nFiles: users.json sessions.json messages.json usage.json proxies.json config-snapshot.json\n`, { name: 'README.txt' });

    zip.finalize();
  });

  const stat = fs.statSync(tmp);
  if (stat.size > 49 * 1024 * 1024) {
    fs.unlinkSync(tmp);
    return ctx.reply('⚠️ Export exceeds Telegram 50MB bot upload limit. Filter by user_id: /admin export <user_id>');
  }

  await ctx.api.sendDocument(home, { source: tmp, filename: path.basename(tmp) }, {
    caption: `📦 Gateway export — ${filterUser ? `user ${filterUser}` : 'all data'} — ${(stat.size / 1024).toFixed(1)} KB`,
  });
  fs.unlinkSync(tmp);
  await ctx.reply(`✅ Exported to home channel (${(stat.size / 1024).toFixed(1)} KB).`);
}
