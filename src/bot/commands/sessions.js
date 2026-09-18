import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import archiver from 'archiver';
import {
  createSession, listSessions, getSession, activateSession, deleteSession,
  getActiveSession, sessionMessagesAll,
} from '../../db.js';
import { config } from '../../config.js';

const HELP = `📒 *Sessions*

\`/sessions list\` — list your saved sessions
\`/sessions new <name>\` — create + activate
\`/sessions resume <name>\` — activate
\`/sessions delete <name>\` — remove (history kept)
\`/sessions rename <old> <new>\` — rename
\`/sessions export [name]\` — zip history → home channel
\`/sessions active\` — show current

A session scopes your conversation history; messages are stored under the active session only.`;

export async function sessionsCommand(ctx) {
  const arg = (ctx.match || '').trim();
  if (!arg || arg === 'help') return ctx.reply(HELP, { parse_mode: 'Markdown' });
  const [sub, ...rest] = arg.split(/\s+/);
  if (sub === 'list') return listCmd(ctx);
  if (sub === 'new') return newCmd(ctx, rest.join(' '));
  if (sub === 'resume') return resumeCmd(ctx, rest.join(' '));
  if (sub === 'delete' || sub === 'rm') return deleteCmd(ctx, rest.join(' '));
  if (sub === 'rename') return renameCmd(ctx, rest[0], rest.slice(1).join(' '));
  if (sub === 'export') return exportCmd(ctx, rest.join(' '));
  if (sub === 'active') return activeCmd(ctx);
  return ctx.reply(HELP, { parse_mode: 'Markdown' });
}

async function listCmd(ctx) {
  const sessions = listSessions(ctx.from.id);
  if (!sessions.length) return ctx.reply('No saved sessions. Use /sessions new <name> to create one.');
  const active = getActiveSession(ctx.from.id);
  const lines = sessions.map((s) => {
    const flag = s.is_active ? '⭐' : '  ';
    const t = new Date(s.updated_at).toISOString().slice(0, 16).replace('T', ' ');
    return `${flag} ${s.name} — ${t} UTC`;
  });
  await ctx.reply(`📒 Your sessions:\n${active ? '⭐ = active\n' : ''}${lines.join('\n')}`);
}

async function newCmd(ctx, name) {
  if (!name) return ctx.reply('Usage: /sessions new <name>');
  if (!/^[\w\- ]{1,40}$/.test(name)) return ctx.reply('Name must be 1-40 chars: letters, numbers, _, -, space.');
  if (getSession(ctx.from.id, name)) return ctx.reply(`Session "${name}" already exists.`);
  createSession(ctx.from.id, name);
  await ctx.reply(`✅ Created and activated session \`${name}\``, { parse_mode: 'Markdown' });
}

async function resumeCmd(ctx, name) {
  if (!name) return ctx.reply('Usage: /sessions resume <name>');
  const sess = activateSession(ctx.from.id, name);
  if (!sess) return ctx.reply(`No session named "${name}".`);
  await ctx.reply(`▶️ Resumed session \`${name}\``, { parse_mode: 'Markdown' });
}

async function deleteCmd(ctx, name) {
  if (!name) return ctx.reply('Usage: /sessions delete <name>');
  const sess = getSession(ctx.from.id, name);
  if (!sess) return ctx.reply(`No session named "${name}".`);
  deleteSession(ctx.from.id, name);
  const remaining = getActiveSession(ctx.from.id);
  await ctx.reply(`🗑 Deleted \`${name}\`${remaining ? `. Active: ${remaining.name}` : '. No active session — history will accumulate across all messages.'}`, { parse_mode: 'Markdown' });
}

async function renameCmd(ctx, oldName, newName) {
  if (!oldName || !newName) return ctx.reply('Usage: /sessions rename <old> <new>');
  if (!/^[\w\- ]{1,40}$/.test(newName)) return ctx.reply('New name must be 1-40 chars.');
  const sess = getSession(ctx.from.id, oldName);
  if (!sess) return ctx.reply(`No session named "${oldName}".`);
  if (getSession(ctx.from.id, newName)) return ctx.reply(`A session named "${newName}" already exists.`);
  const { db } = await import('../../db.js');
  db.prepare('UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?').run(newName, Date.now(), sess.id);
  await ctx.reply(`✏️ Renamed \`${oldName}\` → \`${newName}\``, { parse_mode: 'Markdown' });
}

async function activeCmd(ctx) {
  const a = getActiveSession(ctx.from.id);
  if (!a) return ctx.reply('No active session. Use /sessions new <name>.');
  await ctx.reply(`⭐ Active: \`${a.name}\``, { parse_mode: 'Markdown' });
}

async function exportCmd(ctx, name) {
  const home = config.export.homeChannel;
  if (!home) return ctx.reply('⚠️ TELELEGRAM_HOME_CHANNEL not set in .env.');

  let sessions = [];
  if (name) {
    const s = getSession(ctx.from.id, name);
    if (!s) return ctx.reply(`No session named "${name}".`);
    sessions = [s];
  } else {
    sessions = listSessions(ctx.from.id);
  }
  if (!sessions.length) return ctx.reply('No sessions to export.');

  const tmp = path.join(os.tmpdir(), `sessions-${ctx.from.id}-${Date.now()}.zip`);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    const zip = archiver('zip', { zlib: { level: 9 } });
    out.on('close', resolve);
    zip.on('error', reject);
    zip.pipe(out);

    zip.append(JSON.stringify(sessions, null, 2), { name: 'sessions.json' });

    for (const s of sessions) {
      const msgs = sessionMessagesAll(ctx.from.id, s.id);
      const meta = {
        id: s.id, name: s.name, is_active: s.is_active,
        created_at: new Date(s.created_at).toISOString(),
        updated_at: new Date(s.updated_at).toISOString(),
        message_count: msgs.length,
      };
      zip.append(JSON.stringify(meta, null, 2), { name: `${s.name}/meta.json` });
      const md = renderMarkdown(s, msgs);
      zip.append(md, { name: `${s.name}/conversation.md` });
      zip.append(JSON.stringify(msgs, null, 2), { name: `${s.name}/messages.json` });
    }

    zip.append(`OpenCode Gateway session export\nUser: ${ctx.from.id}\nGenerated: ${new Date().toISOString()}\nSessions: ${sessions.map((s) => s.name).join(', ')}\n`, { name: 'README.txt' });
    zip.finalize();
  });

  const stat = fs.statSync(tmp);
  if (stat.size > 49 * 1024 * 1024) {
    fs.unlinkSync(tmp);
    return ctx.reply('⚠️ Export exceeds Telegram 50MB limit. Export fewer sessions.');
  }

  await ctx.api.sendDocument(home, { source: tmp, filename: path.basename(tmp) }, {
    caption: `📦 Session export — user ${ctx.from.id} — ${sessions.length} session(s) — ${(stat.size / 1024).toFixed(1)} KB`,
  });
  fs.unlinkSync(tmp);
  await ctx.reply(`✅ Sent to home channel (${(stat.size / 1024).toFixed(1)} KB).`);
}

function renderMarkdown(s, msgs) {
  const lines = [];
  lines.push(`# Session: ${s.name}`);
  lines.push('');
  lines.push(`- Created: ${new Date(s.created_at).toISOString()}`);
  lines.push(`- Updated: ${new Date(s.updated_at).toISOString()}`);
  lines.push(`- Messages: ${msgs.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  for (const m of msgs) {
    const t = new Date(m.created_at).toISOString().replace('T', ' ').slice(0, 19);
    lines.push(`### ${m.role.toUpperCase()} — ${t} UTC`);
    lines.push('');
    lines.push(m.content);
    lines.push('');
  }
  return lines.join('\n');
}
