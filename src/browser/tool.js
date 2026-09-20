// language: JavaScript (Node 18+), file: src/browser/tool.js
// Thin wrapper around the `agent-browser` CLI. One persistent browser session
// per Telegram chat, so /browse open + /browse click + /browse read chain.
// No page state in this module: agent-browser owns the session and the page.

import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { stealthFlags, randomUserAgent } from './stealth.js';
import { engineChain } from './search.js';
import { rotatedChatProxy } from '../proxy/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve order: explicit override → local dependency (npm ci installs it) →
// any agent-browser on PATH. The local copy is what makes /browse work with
// zero extra install steps on a fresh clone.
function resolveBrowserBin() {
  if (process.env.AGENT_BROWSER_BIN) {
    try { if (fs.statSync(process.env.AGENT_BROWSER_BIN).isFile()) return process.env.AGENT_BROWSER_BIN; }
    catch { /* fall through */ }
  }
  const localEntry = path.join(__dirname, '..', '..', 'node_modules', 'agent-browser', 'bin', 'agent-browser.js');
  if (fs.existsSync(localEntry)) return localEntry;
  for (const c of ['agent-browser']) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 4000 });
    if (r.status === 0) return c;
  }
  return null;
}

let _BIN;
const browserBin = () => (_BIN ??= resolveBrowserBin());

// serialize per chat so concurrent commands can't race one browser session
const _locks = new Map();
async function withChat(chatId, fn) {
  while (_locks.has(chatId)) await sleep(50);
  _locks.set(chatId, true);
  try { return await fn(); } finally { _locks.delete(chatId); }
}

export function browserAvailable() {
  return browserBin() !== null;
}

// Chromium lives in the Playwright browser cache, keyed by revision. The
// cache marks a finished download with INSTALLATION_COMPLETE; a half-fetch
// is present but unusable, so look for the marker specifically.
let _chromiumCache;
export function browserReady() {
  if (_chromiumCache !== undefined) return _chromiumCache;
  const cacheRoot = path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
      if (!/chromium/i.test(entry.name) || !entry.isDirectory()) continue;
      const mark = path.join(cacheRoot, entry.name, 'INSTALLATION_COMPLETE');
      if (fs.existsSync(mark)) { _chromiumCache = true; return true; }
    }
  } catch { /* no cache yet */ }
  _chromiumCache = false;
  return false;
}
function markReady() { _chromiumCache = true; }

/**
 * Run one agent-browser command.
 * @param {string[]} args   e.g. ['open', 'https://x.com'], ['click', '@e3']
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, stdout:string, stderr:string, code:number}>}
 */
export function browserExec(args, { timeoutMs = 60_000 } = {}) {
  const bin = browserBin();
  return new Promise(resolve => {
    if (!bin) { resolve({ ok: false, stdout: '', stderr: 'agent-browser not installed', code: -1 }); return; }
    const isJs = bin.endsWith('.js');
    const child = spawn(isJs ? process.execPath : bin, isJs ? [bin, ...args] : args, {
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

    // First run ever: the npm package ships without a browser. Fetch Chromium
    // once, then proceed. Subsequent commands are instant.
    if (!browserReady()) {
      const r = await browserExec(['install', 'chromium'], { timeoutMs: 300_000 });
      if (!r.ok) {
        return '⚠️ Chromium belum terpasang dan pengambilan gagal.\n\nJalankan sekali di server: `npm run browser install` lalu coba lagi.';
      }
      markReady();
    }

    // /search is a compound command: it walks the engine fallback chain.
    if (cmd === 'search') return searchCommand(rest, { chatId, timeoutMs });

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

/**
 * /search <query> — try engines in quality order, stop at the first one that
 * returns results. An engine that serves a captcha or a /sorry redirect is
 * blocked on this IP, and retrying it is wasted time.
 */
async function searchCommand(rest, { chatId, timeoutMs }) {
  const query = rest.join(' ').trim();
  if (!query) return 'Usage: `/browse search <query>`';

  const proxy = config.proxy.enabled ? rotatedChatProxy(chatId) : null;
  const hasResidential = Boolean(proxy && /^socks5/.test(proxy));
  const chain = engineChain({ hasResidentialProxy: hasResidential });

  for (const engine of chain) {
    const url = engine.url(query);
    const flags = stealthFlags({ proxy: proxy || undefined });
    const r = await browserExec(['open', url, ...flags], { timeoutMs });

    if (!r.ok) {
      logger.warn({ engine: engine.id, code: r.code }, 'search engine unreachable, next');
      continue;
    }

    // a navigation that "succeeded" can still land on a bot wall — read the
    // page and look for the wall markers before trusting it
    const page = await browserExec(['read'], { timeoutMs: 20_000 });
    const text = clean(page.stdout || '');
    if (isBotWall(text, url)) {
      logger?.warn?.({ engine: engine.id }, 'search engine served a bot wall, next');
      continue;
    }

    const results = parseSearchResults(text, engine.id);
    if (results.length) {
      return `🔍 *${engine.label}* — \`${query}\`\n\n` + results.slice(0, 8).map(
        (x, i) => `${i + 1}. [${x.title}](${x.url})\n   ${x.snippet}`,
      ).join('\n\n');
    }

    // page loaded, no wall, but no results parsed — the markup changed or the
    // engine returned nothing. Try the next engine rather than reporting empty.
    logger?.warn?.({ engine: engine.id }, 'search engine returned no parseable results, next');
  }

  return `❌ No search engine returned results for \`${query}\`.\nTry \`/browse open https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}\` manually.`;
}

/**
 * Wall markers. Google's is a redirect to /sorry with an interstitial; the
 * others are challenge pages with distinctive copy.
 */
function isBotWall(text, url) {
  if (/\/sorry\/index/i.test(url)) return true;
  const t = text.toLowerCase();
  if (/unusual traffic from your computer network/i.test(t)) return true;
  if (/our systems have detected unusual traffic/i.test(t)) return true;
  if (/checking your browser before accessing/i.test(t)) return true;
  if (/enable javascript and cookies to continue/i.test(t)) return true;
  if (/verify you are human/i.test(t) && t.length < 4000) return true;
  return false;
}

/** Pull (title, url, snippet) triples out of the result page text. */
function parseSearchResults(text, engineId) {
  const out = [];
  const lines = (text || '').split('\n').map((l) => l.trim()).filter(Boolean);

  if (engineId === 'brave') {
    // brave's readable text runs: <title>\n<url>\n<snippet>\n\n...
    for (let i = 0; i < lines.length - 2 && out.length < 12; i++) {
      const url = lines[i + 1];
      if (!/^https?:\/\//.test(url)) continue;
      if (url.includes('search.brave.com')) continue;
      const title = lines[i];
      const snippet = lines[i + 2] || '';
      if (title && title.length > 3) out.push({ title, url, snippet });
      i += 2;
    }
    return out;
  }

  // ddg html/lite: result links appear as URL lines too
  for (let i = 0; i < lines.length - 1 && out.length < 12; i++) {
    const url = lines[i];
    if (!/^https?:\/\//.test(url)) continue;
    if (/duckduckgo\.com/i.test(url)) continue;
    const title = lines[i - 1] || url;
    const snippet = lines[i + 1] || '';
    out.push({ title: title.length > 3 ? title : url, url, snippet });
    i += 1;
  }
  return out;
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

\`/browse search <q>\`    🔍 Search — Camoufox anti-detect Firefox
\`/browse browse <url>\`   📄 Read a page — Camoufox
\`/browse open <url>\`     Open URL in headless Chromium
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

*Search engines* try in order (datacenter IPs are blocked at Google):
Brave → DuckDuckGo HTML → DDG Lite. The first one that returns results wins.

**Flow:** \`/browse search <q>\` → pick a result → \`/browse browse <url>\`

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
  'search', 'browse',
]);

export async function browserSafe(args, { chatId = 0, timeoutMs = 90_000 } = {}) {
  const [cmd, ...rest] = args;
  if (!BROWSER_SAFE_CMDS.has(cmd)) {
    return `❌ Unknown command: \`${cmd || '(none)'}\` — try \`/browse\` with no arguments.`;
  }

  // /browse search and /browse browse use the Camoufox backend (anti-detect
  // Firefox). On this VPS, headless Chromium is hard-blocked by Google and
  // captcha-walled by Brave; Camoufox with a real Windows fingerprint gets
  // through the browser checks, and the engine chain handles the IP.
  if (cmd === 'search') return camouSearchCommand(rest);
  if (cmd === 'browse') return camouBrowseCommand(rest);

  // 'url' and 'title' are agent-browser `get` subcommands, not top-level ones
  if (cmd === 'url' || cmd === 'title') {
    return browserCommand(['get', cmd, ...rest], { chatId, timeoutMs });
  }
  return browserCommand([cmd, ...rest], { chatId, timeoutMs });
}

async function camouSearchCommand(rest) {
  const query = rest.join(' ').trim();
  if (!query) return 'Usage: `/browse search <query>`';
  const { camouSearch } = await import('./camoufox.js');
  const r = await camouSearch(query);
  if (r.error) return `❌ ${r.error}`;
  return `🔍 *${r.engine}* — \`${query}\`\n\n` + r.results.slice(0, 8).map(
    (x, i) => `${i + 1}. [${x.title}](${x.url})\n   ${x.snippet.slice(0, 180)}`,
  ).join('\n\n');
}

async function camouBrowseCommand(rest) {
  const url = rest.join(' ').trim();
  if (!url) return 'Usage: `/browse browse <url>`';
  const { camouBrowse } = await import('./camoufox.js');
  const r = await camouBrowse(url);
  if (r.error) return `❌ ${r.error}`;
  return `📄 *${r.title || r.url}*\n${r.url}\n\n${r.text}`.slice(0, 3900);
}

export { usageMarkdown as usage };
