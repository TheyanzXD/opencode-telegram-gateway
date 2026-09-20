// language: JavaScript (Node 20+ ESM), file: src/agent/approval-smart.js
// Guardian LLM. A second, cheap model judges a dangerous call before a keyboard
// is ever sent: clearly-safe and reversible calls run, risky ones still ask.
//
// Why this is not a hole in the gate: the guardian can only *lower* friction on
// calls the user would have approved anyway. It cannot authorize what the user
// would refuse — the class of tool stays dangerous, and the truly destructive
// patterns (rm -rf /, mkfs, dd of=/dev/) are refused before the guardian even
// runs, in the tool itself.
//
// The guardian runs on a SEPARATE, cheap model — never the agent's — because it
// fires on every dangerous call and a judge that costs the same as the work is
// not a judge, it is a second copy of the task.

import { chatCompletion } from '../providers/client.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

const GUARDIAN_PROMPT = `You are an approval guardian. Judge whether a tool call is safe to run WITHOUT human approval.

Tool: <tool>
Arguments: <args>

Reply with exactly one word:
- safe   — read-only, reversible, or confined to a scratch workspace; no external side effects
- risky  — destructive, irreversible, touches shared state, sends data out, or you are unsure

Be conservative. If there is any doubt, say risky. Never output anything but the single word.`;

/** Calls that must always ask, no matter what the guardian thinks. */
const ALWAYS_RISKY_PATTERNS = [
  /\brm\s+-rf?\b/i,
  /\bmkfs\b/i,
  /\bdd\s+.*of=/i,
  /\b(shutdown|reboot|halt)\b/i,
  /:\(\)\s*\{\s*:\|:&\s*\};\s*:/, // fork bomb
  /\bshred\b/i,
  /\bchmod\s+777\b/i,
  /\b(curl|wget)\s+.*\|\s*(sh|bash)\b/i, // piped remote script execution
];

/** Cheap structural pre-check, no model call. */
export function obviouslyRisky(tool, args) {
  const blob = `${tool} ${typeof args === 'string' ? args : JSON.stringify(args ?? {})}`;
  return ALWAYS_RISKY_PATTERNS.some((re) => re.test(blob));
}

/**
 * Ask the guardian whether this call needs a human.
 *
 * @param {string} tool
 * @param {object} args
 * @returns {Promise<'safe'|'risky'|null>} null when the guardian is unavailable
 */
export async function guardianVerdict(tool, args) {
  if (!config.agent.guardianProvider || !config.agent.guardianModel) return null;
  if (obviouslyRisky(tool, args)) return 'risky';

  const body = GUARDIAN_PROMPT
    .replace('<tool>', String(tool).slice(0, 120))
    .replace('<args>', JSON.stringify(args ?? {}).slice(0, 1200));

  try {
    const { content } = await chatCompletion({
      provider: config.agent.guardianProvider,
      model: config.agent.guardianModel,
      messages: [{ role: 'user', content: body }],
      temperature: 0,
      maxTokens: 8,
    });
    const verdict = (content || '').trim().toLowerCase();
    if (verdict.startsWith('safe')) return 'safe';
    if (verdict.startsWith('risky')) return 'risky';
    logger.debug({ verdict: verdict.slice(0, 40) }, 'guardian gave no verdict');
    return null;
  } catch (err) {
    // A dead guardian must not become an open gate — fail closed to 'ask'
    logger.warn({ err: err.message }, 'guardian check failed, defaulting to ask');
    return null;
  }
}
