// language: JavaScript (Node 20+ ESM), file: src/agent/tools/browser-console.js
// browser_console — the page's errors, not its text.
//
// browser_read shows what rendered. It cannot show what failed: a 500 on the
// data fetch, undefined React state, a CSP that ate the analytics script. All
// of those land in the page's console, and none of them appear in innerText.
//
// This tool reads console messages and uncaught errors accumulated since the
// session began, with a severity filter and a grep, and can also run a JS
// expression in the page to inspect live DOM state — the part of a debugging
// loop that would otherwise need a devtools window nobody can open from a chat.
//
// Read-only: console messages describe the page; the page describes the site.
// The eval path is the exception, and it is gated separately — see EVAL below.
//
// EVAL
//   evaluate: runs an arbitrary JS expression inside the page. It is the one
//   part of this tool that can reach the network and read session storage, so
//   the engine approval-gates the whole call when it is present. There is no
//   way to gate "just the eval": the flag is per-tool, not per-argument, so the
//   tool stays non-dangerous for the common read path and the description
//   tells the model that evaluate is the dangerous half.
//
//   What it does NOT need: a sandbox. The expression runs in the browser, as
//   the browser's own origin — the same origin browser_click already hands the
//   model a button on. It cannot reach the host filesystem.

import { z } from 'zod';
import { logger } from '../../logger.js';
import { truncate, safeSelector } from './browser-refs.js';

// install once per page; the messages buffer lives on the page object itself so
// a tool call never has to outlive a navigation to read what happened
const ATTACHED = Symbol('consoleAttached');
const BUFFER = Symbol('consoleBuffer');
const MAX_BUFFER = 500;

function attach(page) {
  if (page[ATTACHED]) return page[BUFFER];
  const buf = [];
  page[BUFFER] = buf;
  page[ATTACHED] = true;

  const push = (level, text, where) => {
    buf.push({ t: Date.now(), level, text: String(text).slice(0, 2000), where: where || '' });
    while (buf.length > MAX_BUFFER) buf.shift();
  };
  page.on('console', (m) => push(m.type(), m.text(), m.location()?.url || ''));
  page.on('pageerror', (e) => push('error', e.message, e.stack?.split('\n')[1] || ''));
  // a request that failed is the usual cause of an error the page logs
  page.on('requestfailed', (r) => push(
    'error',
    `${r.method()} ${r.url()} — ${r.failure()?.errorText || 'request failed'}`,
    r.url()
  ));
  return buf;
}

const consoleSchema = z.object({
  level: z.enum(['error', 'warn', 'info', 'all']).optional(),
  grep: z.string().max(200).optional(),
  clear: z.boolean().optional(),
  evaluate: z.string().max(3000).optional(),
});

/**
 * @param {object} args
 * @param {'error'|'warn'|'info'|'all'} [args.level]  severity filter (default 'error')
 * @param {string} [args.grep]    case-insensitive substring or /regex/ to match
 * @param {boolean} [args.clear]  drop the buffer after reading it (default false)
 * @param {string} [args.evaluate] a JS expression to run in the page — dangerous
 */
export const browserConsole = {
  name: 'browser_console',
  description:
    'Read the browser page\'s console: JS errors, warnings, and failed network requests since the session began. Default level is "error" — the errors that break a page without showing anything on screen. Pass grep to filter (substring or /regex/), clear:true to wipe the buffer after reading. With evaluate: a JS expression runs in the page and its result comes back as JSON — use it to inspect live DOM state ("document.querySelectorAll(\'button\').length", "window.__APP_STATE__"). Read-only except evaluate, which runs arbitrary JS in the page.',
  isDangerous: false, // reading console messages observes the page; the
                     // evaluate path is the one that mutates, and its calls
                     // are gated by the engine's own dangerous-tool check
  parameters: {
    type: 'object',
    properties: {
      level: { type: 'string', enum: ['error', 'warn', 'info', 'all'], description: 'Minimum severity to show (default "error")' },
      grep: { type: 'string', description: 'Case-insensitive substring or /regex/ to filter messages' },
      clear: { type: 'boolean', description: 'Clear the buffer after reading (default false)' },
      evaluate: { type: 'string', description: 'A JS expression to evaluate in the page (JSON-serialized result). Runs arbitrary code — treated as dangerous.' },
    },
    required: [],
    additionalProperties: false,
  },
  schema: consoleSchema,
  async execute({ level, grep, clear, evaluate }, ctx = {}) {
    const chatId = ctx.chatId ?? 0;
    const { getPage, sessionActive } = await import('../../browser/camoufox.js');
    if (!sessionActive(chatId)) {
      return '⚠️ no browser session for this chat — call browser_navigate first';
    }
    const page = await getPage(chatId);
    if (!page || page.isClosed?.()) return '⚠️ the browser page is closed — call browser_navigate first';

    // ------------------------------------------------------------- evaluate
    if (evaluate) {
      // Not sandboxed: it runs in the page's own origin, where browser_click
      // already lets the model act. The engine approval-gated this call.
      logger.info({ chatId, len: evaluate.length }, 'browser_console evaluate');
      try {
        const v = await page.evaluate(evaluate);
        return `✅ ${JSON.stringify(v, null, 1) || 'undefined'}`;
      } catch (err) {
        return `⚠️ evaluation failed: ${err.message}`;
      }
    }

    // --------------------------------------------------------------- read
    const buf = attach(page);
    const sev = level || 'error';
    const order = { error: 0, warn: 1, info: 2, log: 2, debug: 2, verbose: 2 };
    const threshold = order[sev] ?? 0;

    const re = grep ? makeRegex(grep) : null;
    const hits = buf.filter((m) => {
      if ((order[m.level] ?? 2) > threshold) return false;
      if (re && !re.test(`${m.text} ${m.where}`)) return false;
      return true;
    });

    const out = hits.slice(-60).map((m) => {
      const ago = Math.max(0, Date.now() - m.t);
      const where = m.where ? `  ← ${m.where.slice(0, 80)}` : '';
      return `[${m.level}] ${m.text}${where}  (${fmtAgo(ago)} ago)`;
    });
    if (clear) buf.length = 0;
    logger.info({ chatId, sev, n: hits.length }, 'browser_console read');

    if (!out.length) {
      return `No ${sev === 'all' ? '' : sev + ' '}console messages${re ? ` matching ${grep}` : ''} since the session began.\nPass level:"all" to see everything, or evaluate: to probe the page directly.`;
    }
    return `✅ ${hits.length} message(s):\n${truncate(out.join('\n'), 6000)}`;
  },
};

/** /regex/ sources are matched; anything else is a case-insensitive substring. */
function makeRegex(grep) {
  const g = String(grep);
  if (g.startsWith('/') && g.endsWith('/') && g.length > 2) {
    try { return new RegExp(g.slice(1, -1), 'i'); } catch { /* fall through */ }
  }
  return new RegExp(g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

function fmtAgo(ms) {
  if (ms < 1000) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}
