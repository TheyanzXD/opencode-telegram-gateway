// language: JavaScript (Node 20+ ESM), file: src/bot/commands/soul.js
// /soul — read, write, and reset the personality file.
//
// The personality is a file, not a setting. That means it can be versioned,
// shared, and edited by hand; this command is the in-chat editor for it.

import fs from 'node:fs/promises';
import { soulPathFor, loadSoul, SOUL_FILE } from '../../agent/personality.js';
import { workspaceFor } from '../../agent/workspace.js';
import path from 'node:path';

const MD = { parse_mode: 'Markdown' };

export async function soulCommand(ctx) {
  const arg = (ctx.match || '').trim();
  const p = soulPathFor(ctx.from.id);
  await fs.mkdir(path.dirname(p), { recursive: true }).catch(() => {});

  if (!arg || arg === 'show' || arg === 'get') {
    const s = await loadSoul(ctx.from.id);
    const where = s.path ? `\n\n*File:* \`${s.path}\`` : '\n\n*File:* (none — using the built-in default)';
    return ctx.reply('🧠 *Current personality*\n\n' + s.text + where, MD);
  }

  if (arg === 'clear' || arg === 'reset') {
    await fs.rm(p, { force: true });
    return ctx.reply('🗑 Personality cleared. Back to the default.');
  }

  if (arg === 'path') {
    return ctx.reply('Your personality file:\n`' + p + '`', MD);
  }

  if (arg.startsWith('set ')) {
    const body = arg.slice(4).trim();
    if (body.length < 10) return ctx.reply('That personality is too short — give it at least a sentence of intent.');
    await fs.writeFile(p, body + '\n', 'utf8');
    return ctx.reply('✅ Personality saved to `' + p + '`. It applies to your next message.', MD);
  }

  if (arg === 'append ') {
    const body = arg.slice(7).trim();
    if (!body.length) return ctx.reply('Nothing to append.');
    const cur = await fs.readFile(p, 'utf8').catch(() => '');
    await fs.writeFile(p, cur.trimEnd() + '\n\n' + body + '\n', 'utf8');
    return ctx.reply('➕ Appended to your personality.', MD);
  }

  // Treat a bare line as `set <text>` — the common case.
  if (!arg.startsWith('set') && arg.length > 10) {
    await fs.writeFile(p, arg + '\n', 'utf8');
    return ctx.reply('✅ Personality saved to `' + p + '`. It applies to your next message.', MD);
  }

  return ctx.reply(
    [
      '🧠 *Personality — /soul*',
      '',
      '  `/soul` — show the current personality',
      '  `/soul set <markdown>` — replace it',
      '  `/soul append <markdown>` — add to it',
      '  `/soul clear` — back to default',
      '  `/soul path` — where it lives',
      '',
      'The file is `' + SOUL_FILE + '` in your workspace. Edit it directly too — the bot reads it on every turn.',
    ].join('\n'),
    MD,
  );
}
