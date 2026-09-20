// language: JavaScript (Node 20+ ESM), file: src/bot/commands/search.js
// /pin and /search — pin load-bearing turns, search across all history.
//
// /history scrolls. These two are the retrieval layer: pin what matters, then
// find anything by content without knowing when it was said.

import { pinTurn, unpinTurn, listPins, searchHistory, pinnedBlock } from '../features/pinned.js';

const MD = { parse_mode: 'Markdown' };

export async function pinCommand(ctx) {
  const arg = (ctx.match || '').trim();
  const target = ctx.message?.reply_to_message;
  const userId = ctx.from.id;

  if (arg === 'list' || arg === 'show' || (!arg && !target)) {
    const pins = listPins(userId);
    if (!pins.length) {
      return ctx.reply(
        ['📌 *Pinned turns*', '', 'Reply to a message and send `/pin` to keep it.', '  `/pin list` — show pins', '  `/pin <note>` — pin the replied message with a note', '  `/pin clear` — remove all pins'].join('\n'),
        MD,
      );
    }
    const body = pins
      .map((p, i) => `${i + 1}. [${p.role}] ${String(p.content).slice(0, 160)}${p.note ? `\n   _${p.note}_` : ''}`)
      .join('\n');
    return ctx.reply('📌 *Pinned turns*\n\n' + body, MD);
  }

  if (arg === 'clear') {
    const pins = listPins(userId, 1000);
    for (const p of pins) unpinTurn(userId, p.message_id);
    return ctx.reply(`🗑 Cleared ${pins.length} pin(s).`);
  }

  if (!target) {
    return ctx.reply('Reply to the message you want to pin, then send `/pin`.', MD);
  }

  const role = target.from?.id === ctx.me?.id ? 'assistant' : 'user';
  const content = String(target.text || target.caption || '').trim();
  if (content.length < 4) return ctx.reply('That message has no text to pin.');

  const note = arg && arg !== 'list' ? arg : '';
  pinTurn(userId, target.message_id, role, content, note);
  return ctx.reply('📌 Pinned.' + (note ? ` Note: _${note}_` : ''));
}

export async function searchCommand(ctx) {
  const q = (ctx.match || '').trim();
  if (!q) {
    return ctx.reply('Usage: `/search <text>` — searches your full history and pins.', MD);
  }
  const hits = searchHistory(ctx.from.id, q, 12);
  if (!hits.length) return ctx.reply(`🔍 No matches for “${q}”.`);

  const body = hits.map((h, i) => {
    const src = h.source === 'pin' ? '📌' : '💬';
    const c = String(h.content).replace(/[*_`>]/g, '').slice(0, 220);
    return `${src} ${i + 1}. [${h.role}]\n${c}`;
  });
  return ctx.reply(`🔍 *${hits.length} match(es) for “${q}”*\n\n` + body.join('\n\n'), MD);
}

/** Injected into the prompt so pins are always visible to the model. */
export { pinnedBlock };
