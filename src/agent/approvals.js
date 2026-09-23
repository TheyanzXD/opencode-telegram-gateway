// language: JavaScript (Node 18+ ESM), file: src/agent/approvals.js
// Human-in-the-loop gateway. A dangerous tool call parks itself in a Map of
// deferred promises; the Telegram side resolves it from an inline-keyboard
// callback. The engine's await is the pause.
//
// Three behaviors beyond the bare pause:
// - yolo: per-user auto-approve. Dangerous by design; the toggle is explicit.
// - denial breaker: a user who denies N times in a row is tired of being asked.
//   Further dangerous calls in that turn are auto-denied without a keyboard.
// - guardian: a second model judges whether approval is needed at all (see
//   approval-smart.js). Clearly-safe calls run; risky ones still ask.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { logger } from '../logger.js';

/** @type {Map<string, {resolve, reject, createdAt, tool, args, userId}>} */
const pending = new Map();

const TTL_MS = 10 * 60 * 1000; // an approval older than 10 min is stale

// per-user counters: how many consecutive approvals have been denied
const denialStreak = new Map();
const DENIAL_BREAK_THRESHOLD = 3; // after 3 straight denials, stop asking

/** Per-user yolo (auto-approve everything dangerous). */
const yoloUsers = new Set();

/**
 * HMAC key for callback-data signing. Derived from the bot token so a fresh
 * deploy with a new token cannot reuse old approval callbacks, and so two
 * gateways on one host cannot forge each other's signatures.
 */
const HMAC_KEY = process.env.APPROVAL_HMAC_KEY || process.env.TELEGRAM_BOT_TOKEN || 'fallback-do-not-use';

/**
 * Sign an approval id so a callback cannot be forged. Telegram callback_data is
 * visible to any user in the chat (and to anyone who forwards the message), so
 * `approve:<id>` alone lets a third party approve a dangerous tool call by
 * replaying the payload. The signature binds the id to a secret this process
 * holds and the chat the keyboard was sent to.
 *
 * @param {string} id approval id
 * @param {number|string} chatId chat the keyboard was rendered in
 * @returns {string} hex signature, first 16 chars
 */
export function signApproval(id, chatId) {
  return createHmac('sha256', HMAC_KEY)
    .update(`${id}:${chatId}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Constant-time verification of a callback signature.
 * @returns {boolean}
 */
export function verifyApproval(id, chatId, sig) {
  if (!sig || typeof sig !== 'string') return false;
  const want = signApproval(id, chatId);
  if (want.length !== sig.length) return false;
  try {
    return timingSafeEqual(Buffer.from(want, 'utf8'), Buffer.from(sig, 'utf8'));
  } catch {
    return false;
  }
}

/** Callback payload shape: approve:<id>:<sig> */
export function packApprovalCallback(id, chatId) {
  return `approve:${id}:${signApproval(id, chatId)}`;
}

/** Parse + verify in one call. Returns null when the signature does not match. */
export function unpackApprovalCallback(payload, chatId) {
  const parts = String(payload || '').split(':');
  if (parts.length !== 3) return null;
  const [, id, sig] = parts;
  if (!verifyApproval(id, chatId, sig)) return null;
  return { id };
}

export class ApprovalRequired extends Error {
  constructor(approvalId, tool, args) {
    super(`approval required: ${tool}`);
    this.name = 'ApprovalRequired';
    this.approvalId = approvalId;
    this.tool = tool;
    this.args = args;
  }
}

export function setYolo(userId, on) {
  if (on) yoloUsers.add(userId);
  else {
    yoloUsers.delete(userId);
    denialStreak.delete(userId);
  }
}

export function isYolo(userId) {
  return yoloUsers.has(userId);
}

/** Called when a user denies. Tracks the streak and reports whether asking is pointless. */
export function noteDenial(userId) {
  const n = (denialStreak.get(userId) || 0) + 1;
  denialStreak.set(userId, n);
  return n >= DENIAL_BREAK_THRESHOLD;
}

/** Any approve resets the streak — the user is engaging again. */
export function noteApproval(userId) {
  denialStreak.delete(userId);
}

export function denialBroken(userId) {
  return (denialStreak.get(userId) || 0) >= DENIAL_BREAK_THRESHOLD;
}

/**
 * Decide what happens to a dangerous call, without creating an approval yet.
 * Returns one of: 'allow' (yolo or guardian-approved), 'ask' (keyboard),
 * 'deny' (denial breaker tripped).
 */
export function gateDecision(userId, tool, guardianVerdict) {
  if (isYolo(userId)) return 'allow';
  if (denialBroken(userId)) return 'deny';
  // guardian 'safe' lowers friction only; 'risky' and null (unavailable) both ask
  if (guardianVerdict === 'safe') return 'allow';
  return 'ask';
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
  if (approved) noteApproval(p.userId);
  else noteDenial(p.userId);
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

// ---------------------------------------------------------------------------
// Dual custody: the most destructive operations need TWO different admins to
// agree before they run. One admin taps ✅; the second admin gets a fresh
// keyboard and taps again. Neither admin can approve their own request twice.
// ---------------------------------------------------------------------------

/**
 * Tools destructive enough to require two admins. Anything that can take the
 * service itself down or destroy user data irreversibly lands here.
 */
const DUAL_CUSTODY_TOOLS = new Set([
  'wipe_volume', 'destroy_data', 'deploy_update', 'delete_repo', 'drop_database',
]);

/** A pending dual-custody request: { firstAdmin, tool, args, resolve, createdAt }. */
const dualPending = new Map();
const DUAL_TTL_MS = 10 * 60 * 1000;

export function requiresDualCustody(tool) {
  return DUAL_CUSTODY_TOOLS.has(tool);
}

/**
 * Start (or continue) a dual-custody approval.
 * @returns {{ id: string, needsSecond: boolean }} needsSecond: true when the
 *   first admin already approved and a SECOND admin is now required
 */
export function dualCustodyGate({ userId, tool, args }) {
  if (!requiresDualCustody(tool)) return { id: null, needsSecond: false };

  const existing = [...dualPending.values()].find(
    (p) => p.tool === tool && JSON.stringify(p.args) === JSON.stringify(args),
  );

  if (!existing) {
    const id = `dual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    dualPending.set(id, {
      id, firstAdmin: userId, tool, args,
      firstApproved: true, createdAt: Date.now(),
    });
    setTimeout(() => dualPending.delete(id), DUAL_TTL_MS).unref?.();
    return { id, needsSecond: true };
  }

  // A second, different admin: release the gate.
  if (existing.firstAdmin !== userId) {
    dualPending.delete(existing.id);
    return { id: existing.id, needsSecond: false };
  }

  // The same admin tapping again does not count as a second approval.
  return { id: existing.id, needsSecond: true };
}

function expireApproval(id) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  logger.warn({ id, tool: p.tool }, 'approval expired');
  p.resolve(false); // deny by default when nobody answers
}
