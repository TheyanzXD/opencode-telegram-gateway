// language: JavaScript (Node 20+ ESM), file: src/agent/rbac.js
// Role-Based Access Control for tool execution.
//
// The gateway already gates *chat* access (db.isAllowed). This is the layer
// below it: not "can this person talk to the bot," but "can this person run
// execute_bash through the bot." Those are different questions, and conflating
// them is how a whitelisted user gets a shell by accident.
//
// Three tiers, and the reason for each:
//
//   user    the default. Chat yes, dangerous tools no — they ask a human, which
//           is the approval flow already in place.
//   trusted chat yes, dangerous tools yes without a keyboard. For the operator's
//           own account on a single-user deploy. Equivalent to /yolo, but set
//           in .env instead of per-conversation.
//   admin   everything trusted has, plus operator commands (/quota set, /export,
//           /admin panel). Already gated by isAdmin elsewhere; this names it.
//
// TELEGRAM_TOOL_USERS is the switch. Empty (the default) means everyone is
// 'user' — the safe posture, no behavior change on an existing deploy.

import { config, isAllowed, isAdmin } from '../config.js';
import { getUser } from '../db.js';

const TRUSTED = new Set((config.telegram.toolUsers || []).map(String));
const ADMINS = new Set((config.telegram.admins || []).map(String));

/**
 * The role for a user id. Everything is derived, nothing is stored per user,
 * so changing .env and SIGHUP-reloading is enough to promote someone.
 */
export function roleOf(userId) {
  const id = String(userId ?? '');
  if (ADMINS.has(id)) return 'admin';
  if (TRUSTED.has(id)) return 'trusted';
  return 'user';
}

/** Can this person talk to the bot at all. */
export function canChat(userId) {
  const id = String(userId ?? '');
  return isAllowed(id) && !isBanned(id);
}

/** Can this person run the tool at all — any tier, read-only or dangerous. */
export function canUseTools(userId) {
  return isAllowed(String(userId ?? ''));
}

/**
 * Can this person run a *dangerous* tool without an approval keyboard.
 * RBAC does not replace the approval flow; it decides who skips it. A 'user'
 * still runs the tool — after a human taps approve.
 */
export function canRunDangerous(userId) {
  const role = roleOf(userId);
  return role === 'trusted' || role === 'admin';
}

/**
 * Can this person run operator commands (/quota set, /admin, /sessions export).
 * Falls back to the existing admin list so a deploy without the new env var
 * behaves exactly as before.
 */
export function canOperate(userId) {
  return roleOf(userId) === 'admin';
}

/** Per-tool override: a role that is not enough is a hard no, not an approval. */
export function toolDeniedFor(userId, toolName) {
  // Nothing is hard-denied to a trusted or admin role.
  const role = roleOf(userId);
  if (role === 'admin' || role === 'trusted') return false;
  // The operator-only tools. A regular user calling these gets a refusal, not
  // a keyboard — approving a /quota change for a stranger is not a decision
  // the approval flow was built to make.
  return OPERATOR_TOOLS.has(toolName);
}

const OPERATOR_TOOLS = new Set(['set_quota', 'export_all', 'restore_backup']);

function isBanned(userId) {
  try {
    return Boolean(getUser(userId)?.is_banned);
  } catch {
    return false;
  }
}
