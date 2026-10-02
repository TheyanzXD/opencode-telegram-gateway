import fs from 'node:fs';
import path from 'node:path';
import { getUser, setUserCwd } from '../../db.js';
import { config } from '../../config.js';
import { defaultCwdFor } from '../../agent/sandbox.js';

export async function cwdCommand(ctx) {
  const u = getUser(ctx.from.id);
  const current = defaultCwdFor(u || {}, config);
  const arg = ctx.match?.trim();
  if (!arg) {
    return ctx.reply(
      `📂 cwd: \`${current}\`\n\nSet with \`/cwd <path>\`. Paths are sandboxed to the bot's working directory and must be a real directory.`,
      { parse_mode: 'Markdown' }
    );
  }
  // Resolve relative to the BOT's cwd, not the user's, so users can't set arbitrary root paths.
  const abs = path.isAbsolute(arg) ? arg : path.resolve(process.cwd(), arg);
  let st;
  try { st = fs.statSync(abs); } catch { return ctx.reply(`❌ not a real path: ${abs}`); }
  if (!st.isDirectory()) return ctx.reply(`❌ not a directory: ${abs}`);
  setUserCwd(ctx.from.id, abs);
  await ctx.reply(`✅ cwd set to \`${abs}\``, { parse_mode: 'Markdown' });
}