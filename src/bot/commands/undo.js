// language: JavaScript (Node 20+ ESM), file: src/bot/commands/undo.js
// /undo — the agent edits files; this is the way back.
//
// What it undoes: the most recent change the agent made in this user's
// workspace. Snapshot is taken by the mutating tools themselves, so this is
// always one tap away after any edit.

import { undo, undoDepth } from '../../agent/snapshot.js';
import { canOperate } from '../../agent/rbac.js';

export async function undoCommand(ctx) {
  const userId = ctx.from?.id ?? ctx.chat?.id;
  // Anyone can undo their own workspace's last change; it restores, it does
  // not escalate.
  const depth = undoDepth(userId);
  if (!depth) {
    return ctx.reply('Nothing to undo — the agent has not changed any file yet.');
  }

  const res = undo(userId);
  if (!res.ok) return ctx.reply(`⚠️ ${res.reason}`);
  return ctx.reply(`↩️ ${res.message}\n\n${undoDepth(userId)} more undo(s) available.`);
}
