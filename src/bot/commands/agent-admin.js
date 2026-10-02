// language: JavaScript (Node 20+ ESM), file: src/bot/commands/agent-admin.js
// /yolo [on|off]  — auto-approve every dangerous tool call for this user.
// /estop         — emergency stop: cancel every running agent turn and deny
//                  every pending approval, immediately.

import { config } from '../../config.js';
import { setYolo, isYolo, rejectAllForUser } from '../../agent/approvals.js';
import { turnLease } from '../../agent/turn-lease.js';
import { logger } from '../../logger.js';

export async function yoloCommand(ctx) {
  const arg = (ctx.match || '').trim().toLowerCase();
  if (arg !== 'on' && arg !== 'off') {
    return ctx.reply(
      `Yolo is currently **${isYolo(ctx.from.id) ? 'ON ⚠️' : 'off'}**.\nUsage: \`/yolo on\` or \`/yolo off\``,
      { parse_mode: 'Markdown' },
    );
  }
  setYolo(ctx.from.id, arg === 'on');
  logger.warn({ user: ctx.from.id, on: arg === 'on' }, 'yolo toggled');
  return ctx.reply(
    arg === 'on'
      ? '⚠️ Yolo ON. Dangerous tool calls run without asking. Use `/yolo off` to restore approvals.'
      : '✅ Yolo off. Dangerous tools ask for approval again.',
    { parse_mode: 'Markdown' },
  );
}

export async function estopCommand(ctx) {
  // every pending approval for this user is denied, and every in-flight lease
  // is released so a queued turn cannot start after the stop
  rejectAllForUser(ctx.from.id);
  turnLease.releaseAll();
  logger.error({ user: ctx.from.id }, 'ESTOP triggered');
  return ctx.reply('🛑 Emergency stop. All running agents cancelled, all approvals denied.');
}
