// language: JavaScript (Node 20+ ESM), file: src/bot/commands/browse.js
// /browse <url> — browse a website URL, extract clean markdown and show links.

import { browseWebsite } from '../../agent/web_browse.js';

const MD = { parse_mode: 'Markdown' };

export async function browseCommand(ctx) {
  const url = (ctx.match || '').trim();
  if (!url) {
    return ctx.reply('Usage: `/browse <url>`\nExample: `/browse https://xerj.org`', MD);
  }

  await ctx.api.sendChatAction(ctx.chat.id, 'typing');
  const res = await browseWebsite({ url, extract_links: true, max_chars: 3500 });
  if (!res.ok) {
    return ctx.reply(`❌ *Browse Failed:* ${res.error}`, MD);
  }

  const out = res.output.slice(0, 3900);
  return ctx.reply(out);
}
