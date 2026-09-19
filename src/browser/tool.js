// language: JavaScript (Node 18+), file: src/browser/tool.js
// Thin wrapper around the `agent-browser` CLI. One persistent browser session
// per Telegram chat, so /browse open + /browse click + /browse read chain.
// No page state in this module: agent-browser owns the session and the page.

import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const BROWSER_BIN = process.env.AGENT_BROWSER_BIN || 'agent-browser';

// serialize per chat so concurrent commands can't race one browser session
const _locks = new Map();
async function withChat(chatId, fn) {
  while (_locks.has(chatId)) await sleep(50);
  _locks.set(chatId, true);
  try { return await fn(); } finally { _locks.delete(chatId); }
}

export function browserAvailable() {
  try {
    return spawnSync(BROWSER_BIN, ['--version'], { encoding: 'utf8', timeout: 4000 }).status === 0;
  } catch { return false; }
}

/**
 * Run one agent-browser command.
 * @param {string[]} args   e.g. ['open', 'https://x.com'], ['click', '@e3']
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, stdout:string, stderr:string, code:number}>}
 */
export function browserExec(args, { timeoutMs = 60_000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(BROWSER_BIN, args, {
      timeout: timeoutMs,
      env: { ...process.env },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { if (d) stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { if (d) stderr += d.toString('utf8'); });
    child.on('error', err => resolve({ ok: false, stdout, stderr: err.message, code: -1 }));
    child.on('close', code => resolve({ ok: code === 0, stdout, stderr, code }));
  });
}

export async function browserCommand(args, { chatId = 0, timeoutMs = 60_000 } = {}) {
  if (!browserAvailable()) return usageMarkdown();
  return withChat(chatId, async () => {
    const [cmd, ...rest] = args;
    if (!cmd) return usageMarkdown();

    const r = await browserExec([cmd, ...rest], { timeoutMs });

    if (!r.ok) {
      const hint = guessError(stderrClean(r.stderr));
      return `❌ \`${cmd}\` failed (${r.code})\n${hint || stderrClean(r.stderr) || 'no output'}`.trimEnd();
    }

    const out = clean(r.stdout);
    if (cmd === 'open')      return `✅ ${out.trim() || 'opened'}`;
    if (cmd === 'close')     return `✅ ${out.trim() || 'closed'}`;
    if (cmd === 'screenshot') return `📸 ${out.trim()}`;
    if (cmd === 'snapshot')  return renderSnapshot(out);
    if (cmd === 'read')      return `📄 ${out.trim()}`;
    return `✅ \`${cmd}\`\n${out}`.trimEnd();
  });
}

function renderSnapshot(out) {
  // agent-browser snapshot prints an accessibility tree with [ref=eNNN] markers
  // on interactive elements. Convert to clickable @eNNN form and keep only
  // element lines (labels + refs) — the tree's LayoutTable noise is useless.
  const lines = (out || '').split('\n')
    .map(l => l.replace(/\[ref=(e\d+)\]/g, '@$1').trimEnd())
    .filter(l => l.includes('@e') && l.trim().startsWith('-'))
    .map(l => l.replace(/^\s*-\s*/, '').trim());
  const refs = dedupe(lines).slice(0, 45);
  if (!refs.length) return '✅ snapshot — no interactive elements found';
  return ['✅ *Interactive elements* (use `@eN` with click/type/fill):', ...refs]
    .join('\n').slice(0, 3900);
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const a of arr) {
    const key = (a.match(/@e\d+/) || [a])[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

export function usageMarkdown() {
  return `*Browser commands*

\`/browse open <url>\`      Open URL in headless Chromium
\`/browse read\`            Extract page text
\`/browse snapshot\`        List interactive elements as \`@eN\` refs
\`/browse click <ref|sel>\` Click an element or \`@eN\` ref
\`/browse type <sel> <text>\` Type into an element
\`/browse fill <sel> <text>\` Clear and fill
\`/browse press <key>\`     Press Enter / Tab / Control+a
\`/browse scroll <dir>\`    Scroll up|down|left|right
\`/browse back\` / \`forward\` / \`reload\`
\`/browse screenshot\`      Capture page
\`/browse url\`             Current URL
\`/browse close\`           Close the session

**Flow:** \`/browse open <url>\` → \`/browse snapshot\` → \`/browse click @e5\` → \`/browse read\`

One session per chat — state persists between commands until \`/browse close\`.`;
}

const _hintTable = [
  ['not found', 'Element not found — run `/browse snapshot` again for fresh `@eN` refs (the page may have changed).'],
  ['timeout', 'Timed out — page slow or element not rendered yet. Try `/browse wait 2000` then repeat.'],
  ['Target page has been closed', 'Browser session closed. Restart with `/browse open <url>`.'],
  ['Cannot navigate to invalid URL', 'Invalid URL — include the protocol (`https://`).'],
  ['browserType.launch', 'Chromium not found. Install it: `agent-browser install chromium`'],
];

function guessError(msg) {
  for (const [pat, hint] of _hintTable) if (msg.includes(pat)) return '💡 ' + hint;
  return '';
}

function clean(s) { return (s || '').replace(/\[agent-browser\][^\n]*\n/g, ''); }
function stderrClean(s) { return (s || '').replace(/\[agent-browser\][^\n]*\n/g, '').trim(); }

export const BROWSER_SAFE_CMDS = new Set([
  'open', 'read', 'click', 'type', 'fill', 'press', 'hover', 'check', 'uncheck',
  'select', 'scroll', 'scrollintoview', 'wait', 'screenshot', 'snapshot', 'eval',
  'close', 'back', 'forward', 'reload', 'find', 'get', 'is', 'url', 'title',
]);

export async function browserSafe(args, { chatId = 0, timeoutMs = 90_000 } = {}) {
  const [cmd, ...rest] = args;
  if (!BROWSER_SAFE_CMDS.has(cmd)) {
    return `❌ Unknown command: \`${cmd || '(none)'}\` — try \`/browse\` with no arguments.`;
  }
  // 'url' and 'title' are agent-browser `get` subcommands, not top-level ones
  if (cmd === 'url' || cmd === 'title') {
    return browserCommand(['get', cmd, ...rest], { chatId, timeoutMs });
  }
  return browserCommand([cmd, ...rest], { chatId, timeoutMs });
}

export { usageMarkdown as usage };
