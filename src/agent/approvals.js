// language: JavaScript (Node 18+ ESM), file: src/agent/approvals.js
// Human-in-the-loop gateway. A dangerous tool call parks itself in a Map of
// deferred promises; the Telegram side resolves it from an inline-keyboard
// callback. The engine's await is the pause.

import { logger } from '../logger.js';

/** @type {Map<string, {resolve, reject, createdAt, tool, args, userId}>} */
const pending = new Map();

const TTL_MS = 10 * 60 * 1000; // an approval older than 10 min is stale

export class ApprovalRequired extends Error {
  constructor(approvalId, tool, args) {
    super(`approval required: ${tool}`);
    this.name = 'ApprovalRequired';
    this.approvalId = approvalId;
    this.tool = tool;
    this.args = args;
  }
}

export function createApproval(userId, tool, args) {
  const id = `appr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  /** @type {Promise<boolean>} */
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, createdAt: Date.now(), userId, tool, args });
  });
  // TTL: an unattended approval must not hang the engine forever
  setTimeout(() => expireApproval(id), TTL_MS).unref?.();
  return { id, promise };
}

export function getApproval(id) {
  return pending.get(id) || null;
}

export function listPending() {
  return [...pending.values()].map((p) => ({ id: [...pending.keys()].find((k) => pending.get(k) === p), ...p }));
}

export function resolveApproval(id, approved) {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  logger.info({ id, tool: p.tool, approved }, 'approval resolved');
  p.resolve(approved);
  return true;
}

export function rejectAllForUser(userId) {
  for (const [id, p] of pending) {
    if (p.userId === userId) {
      pending.delete(id);
      p.resolve(false);
    }
  }
}

function expireApproval(id) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  logger.warn({ id, tool: p.tool }, 'approval expired');
  p.resolve(false); // deny by default when nobody answers
}
