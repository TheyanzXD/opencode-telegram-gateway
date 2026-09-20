// language: JavaScript (Node 20+ ESM), file: src/agent/context.js
// Context + compression manager.
//
// The problem: a long conversation grows until it no longer fits. The naive fix
// — drop the oldest messages — throws away the instructions and constraints the
// user gave early, which are usually the most important ones.
//
// Hermes' rule, carried over: protect the head and the tail, summarize the
// middle. The system prompt and the first user turn are the load-bearing prefix
// (dropping them invalidates the provider's prompt cache and multiplies cost);
// the recent turns are what the model is actually working on; the middle is
// summarized into one compact block.
//
// The summary turn replaces the messages it covers, so the prefix above it
// stays byte-identical and the cache still hits.

import { logger } from '../logger.js';

const DEFAULT_MAX_CHARS = 24_000;   // soft budget for visible history, in characters
const SUMMARY_MARKER = '[summary]';

/**
 * Compress a message list in place-ish (returns a new array).
 *
 * @param {Array<{role, content}>} messages
 * @param {object} opts
 * @param {number} [opts.maxChars]   budget; under it, returned unchanged
 * @param {number} [opts.keepHead]   protected turns at the start
 * @param {number} [opts.keepTail]   protected turns at the end
 * @param {(text: string) => Promise<string>} [opts.summarize]
 *        async summarizer; when absent, the middle is kept but marked, so the
 *        call never blocks on a missing model
 * @returns {Promise<Array>} compressed, or the original array if it fits
 */
export async function compressContext(messages, opts = {}) {
  const {
    maxChars = DEFAULT_MAX_CHARS,
    keepHead = 2,
    keepTail = 6,
    summarize = null,
  } = opts;

  if (!messages?.length) return messages || [];

  // Only compress once per build: a list already carrying a summary marker is
  // itself the output of a previous compression.
  const alreadyCompressed = messages.some((m) => typeof m.content === 'string' && m.content.startsWith(SUMMARY_MARKER));
  if (alreadyCompressed) return messages;

  const total = messages.reduce((n, m) => n + estChars(m.content), 0);
  if (total <= maxChars) return messages;

  // head + tail must not overlap; if the list is tiny just return it
  if (messages.length <= keepHead + keepTail) return messages;

  const head = messages.slice(0, keepHead);
  const middle = messages.slice(keepHead, messages.length - keepTail);
  const tail = messages.slice(messages.length - keepTail);

  const middleText = middle
    .map((m, i) => `[${m.role}] ${flatten(m.content)}`)
    .join('\n\n')
    .slice(0, 12_000);

  let summaryBlock;
  if (summarize) {
    try {
      const summary = await summarize(middleText);
      summaryBlock = `${SUMMARY_MARKER} Earlier in this conversation:\n${summary}`;
    } catch (err) {
      logger.warn({ err: err.message }, 'context summarization failed — keeping middle verbatim');
      // falling back to the raw middle is the safe failure: nothing is lost
      return messages;
    }
  } else {
    // no summarizer configured: truncate the middle to a hard cap
    summaryBlock = `${SUMMARY_MARKER} Earlier messages (truncated to fit):\n${middleText.slice(0, 4000)}`;
  }

  const compressed = [...head, { role: 'system', content: summaryBlock }, ...tail];
  const after = compressed.reduce((n, m) => n + estChars(m.content), 0);
  logger.info({ before: total, after, kept: middle.length }, 'context compressed');
  return compressed;
}

/** Characters for budgeting: text length, or a rough per-image token cost. */
function estChars(content) {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((n, part) => {
      if (part.type === 'text') return n + (part.text?.length ?? 0);
      if (part.type === 'image_url') return n + 768; // an image costs ~768 chars of budget
      return n + 200;
    }, 0);
  }
  return 200;
}

/** Flatten a message body to plain text (image parts become a placeholder). */
function flatten(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p.type === 'text' ? p.text : p.type === 'image_url' ? '[image]' : ''))
      .join(' ');
  }
  return String(content ?? '');
}

/**
 * Prefix-stable prompt assembly. The system prompt is assembled ONCE per user
 * (until they change it) so the cached prefix stays identical turn after turn.
 * Anything volatile — current date, workspace hint, session name — goes in a
 * separate, final "runtime environment" message, never in the system prompt.
 *
 * Providers cache by exact prefix match. Put the time in the system prompt and
 * every turn pays full price.
 *
 * @param {object} user
 * @param {string} currentTurn
 * @param {object} opts
 * @param {string} [opts.runtimeContext]  volatile context, appended as a system message
 * @param {(text: string) => Promise<string>} [opts.summarize]
 */
export async function buildStableMessages(user, currentTurn, opts = {}) {
  const systemPrompt = user.system_prompt || 'You are a helpful assistant.';
  const runtime = opts.runtimeContext || null;

  const history = (opts.history || []).map((m) => ({ role: m.role, content: m.content }));
  const compressed = await compressContext(history, { summarize: opts.summarize });

  const out = [{ role: 'system', content: systemPrompt }];
  if (runtime) out.push({ role: 'system', content: runtime });
  out.push(...compressed, { role: 'user', content: currentTurn });
  return out;
}

/**
 * The runtime-environment block: everything that changes between turns.
 * Kept deliberately small — it sits below the cached prefix, so it costs.
 */
export function runtimeContext({ sessionName = null, workspace = null } = {}) {
  const bits = [
    `Current date: ${new Date().toISOString().slice(0, 10)} (UTC)`,
  ];
  if (sessionName) bits.push(`Active session: ${sessionName}`);
  if (workspace) bits.push(`Workspace: ${workspace}`);
  return bits.join('\n');
}

/**
 * Memory hook — Hermes injects remembered facts as a system message below the
 * prefix. Ours is a placeholder that reads from the memory layer when present.
 */
export function memoryBlock(facts = []) {
  if (!facts.length) return null;
  return `Facts you know about this user (from memory):\n${facts.map((f) => `- ${f}`).join('\n')}`;
}
