// language: JavaScript (Node 18+ ESM), file: src/bot/commands/debug.js
// /debug   — last agent trace for this chat (provider calls, tools, approvals, errors)
// /plugins — loaded plugins + any that failed to load
//
// The tracer is per engine run; only the most recent run per chat is kept.

import { pluginsLoader } from '../../plugins/state.js';

const lastTraces = new Map();

export function rememberTrace(chatId, tracer) {
  lastTraces.set(String(chatId), tracer);
}

export async function debugCommand(ctx) {
  const tracer = lastTraces.get(String(ctx.chat.id));
  if (!tracer) return ctx.reply('No agent run traced in this chat yet. Use /agent first.');
  const body = tracer.render(30);
  return ctx.reply('```\n' + body.slice(0, 3800) + '\n```', { parse_mode: 'Markdown' });
}

export async function pluginsCommand(ctx) {
  const loader = pluginsLoader();
  if (!loader) return ctx.reply('Plugin system not initialized.');
  if (!loader.loaded.length && !loader.errors.length) {
    return ctx.reply(
      'No plugins found. Drop one in `plugins/` — see docs/plugins.md.',
      { parse_mode: 'Markdown' },
    );
  }
  const ok = loader.loaded.map((p) => `✅ ${p.name}`);
  const bad = loader.errors.map((e) => `❌ ${e.plugin} — ${e.message}`);
  return ctx.reply([...ok, ...bad].join('\n').slice(0, 4000));
}
