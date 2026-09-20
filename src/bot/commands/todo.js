// language: JavaScript (Node 18+ ESM), file: src/bot/commands/todo.js
// /todo — the todo tools have a chat surface too. A task list is only useful
// if the human can see it without asking the agent.

import { readTodos } from '../../agent/store-kv.js';

export async function todoCommand(ctx) {
  const userId = String(ctx.from?.id ?? ctx.chat?.id ?? '0');
  const todos = readTodos(userId) || [];

  if (!todos.length) {
    return ctx.reply(
      'No tasks tracked. The agent tracks a list with `todowrite` — ask it to plan the work and it shows up here.',
      { parse_mode: 'Markdown' },
    );
  }

  const done = todos.filter((x) => x.status === 'completed').length;
  const header = `*Tasks* — ${done}/${todos.length} done\n\n`;
  const body = todos
    .map((x, i) => {
      const mark = x.status === 'completed' ? '✅' : x.status === 'in_progress' ? '🔄' : '⬜';
      const label = x.activeForm || x.content;
      return x.status === 'in_progress' ? `${mark} *${i + 1}. ${label}*` : `${mark} ${i + 1}. ${label}`;
    })
    .join('\n');

  return ctx.reply(header + body, { parse_mode: 'Markdown' });
}
