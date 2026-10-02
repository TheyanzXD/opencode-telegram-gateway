import { tools } from '../../agent/tools.js';

export async function toolsCommand(ctx) {
  const lines = ['🛠 *available tools*'];
  for (const t of tools) {
    lines.push(`• \`${t.name}\` — ${t.description}`);
  }
  lines.push('', 'Tools run with paths sandboxed to your `/cwd`. `bash_exec` requires inline approval per call.');
  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
}