// language: JavaScript (Node 20+ ESM), file: src/browser/camoufox.js
// Camoufox-backed browse + search. Anti-detect Firefox via camoufox-js.
//
// Why a second backend: headless Chromium on this VPS gets hard-blocked at the
// network layer. Google redirects to /sorry before the page loads, and Brave
// serves its "verifying you're not a bot" interstitial. Camoufox fixes the
// browser side — real Windows/Firefox fingerprint, navigator.webdriver false —
// but it cannot fix the IP reputation. So search falls back through engines
// ordered by how well they tolerate a datacenter IP:
//
//    ddg-html  — no-JS endpoint, works on this IP, stable
//    ddg-lite  — smaller page, same engine
//    brave     — captcha on this IP, kept for when a proxy is in front
//
// Google stays available to a user who browser_navigates there directly,
// intentionally not in the search chain.
//
// SETUP: Camoufox binaries must be present. The `camou` npm package installs
// them with `camou install`; camoufox-js resolves the same cache once its
// version.json is in the shape it expects (see ensureCamoufoxEnv).

import { launchOptions } from 'camoufox-js';
import { firefox } from 'playwright-core';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';

const CAMOUFOX_CACHE = '/root/.cache/camoufox';

/**
 * Resolve the Camoufox install for this process.
 *
 * bootstrap.js sets CAMOUFOX_INSTALL_DIR at startup from the `camou` CLI's own
 * registry, and rewrites version.json into the shape camoufox-js expects. This
 * function only reads that decision back — it does not mutate anything.
 *
 * @returns {string|null} the browser dir, or null if Camoufox is not installed
 */
export function ensureCamoufoxEnv() {
  const dir = process.env.CAMOUFOX_INSTALL_DIR || null;
  if (!dir) return null;
  if (!existsSync(path.join(dir, 'camoufox-bin'))) return null;

  // addon downloads fail in this sandbox; skip them entirely
  if (!process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD) {
    process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1';
  }
  return dir;
}

// One browser per chat: the turn lease keeps one agent turn per chat, but two
// chats can run concurrently and must never share a page or a ref map.
const _sessions = new Map(); // chatId → {browser, context, page}

// Where this chat's storageState lives: cookies + localStorage, saved on close
// and replayed on launch. Keeping it under the agent's data dir, not the
// workspace, so a workspace wipe does not log every user out.
function statePath(chatId) {
  const root = path.join(process.cwd(), 'data', 'browser-state');
  try { mkdirSync(root, { recursive: true }); } catch {}
  return path.join(root, `state-${chatId}.json`);
}

export async function getPage(chatId) {
  const existing = _sessions.get(chatId);
  if (existing?.page) return existing.page;

  const dir = ensureCamoufoxEnv();
  if (!dir) throw new Error('Camoufox not installed — run `npx camou install` first');

  // os: 'windows' generates a real Windows/Firefox fingerprint. ff_version
  // bypasses camoufox-js's version probe (i_know_what_im_doing silences the
  // warning it would otherwise raise for the override).
  const opts = await launchOptions({
    headless: true,
    os: 'windows',
    ff_version: 152,
    i_know_what_im_doing: true,
    block_images: true,
  });
  const browser = await firefox.launch(opts);
  // A saved storageState replays cookies and localStorage, so a login from a
  // previous session survives a browser restart. A corrupt or partial file is
  // ignored — a bad state must never block a fresh session.
  const stateFile = statePath(chatId);
  let context;
  try {
    const raw = existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : null;
    context = raw ? await browser.newContext({ storageState: JSON.parse(raw) }) : await browser.newContext();
  } catch (err) {
    logger.warn({ err: err.message }, 'bad storageState — starting fresh');
    context = await browser.newContext();
  }
  const page = await context.newPage();
  _sessions.set(chatId, { browser, context, page, stateFile });
  logger.info({ chatId }, 'camoufox browser launched (windows fingerprint)');
  return page;
}

/** True when this chat has a live page (used by /about and browser_close hints). */
export async function saveBrowserState(chatId) {
  const s = _sessions.get(chatId);
  if (!s?.context) return false;
  try {
    const state = await s.context.storageState();
    writeFileSync(s.stateFile || statePath(chatId), JSON.stringify(state));
    return true;
  } catch { return false; }
}

export function sessionActive(chatId) {
  const s = _sessions.get(chatId);
  return Boolean(s && s.page && !s.page.isClosed?.());
}

async function closeBrowser(chatId) {
  const s = _sessions.get(chatId);
  if (!s) return;
  // Persist auth before teardown. A failure here is not fatal — the next
  // session just starts logged out.
  if (s.stateFile) {
    try {
      const state = await s.context.storageState();
      writeFileSync(s.stateFile, JSON.stringify(state));
    } catch (err) { logger.warn({ err: err.message }, 'storageState save failed'); }
  }
  try { await s.browser?.close(); } catch {}
  _sessions.delete(chatId);
}

const SEARCH_ENGINES = [
  {
    id: 'ddg',
    label: 'DuckDuckGo',
    // the no-JS endpoint: same index, none of the JS app's bot heuristics
    url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
  },
  {
    id: 'ddg-lite',
    label: 'DuckDuckGo Lite',
    url: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
  },
  {
    id: 'brave',
    label: 'Brave',
    url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}`,
  },
];

function isBotWall(text, url) {
  if (/\/sorry\/index/i.test(url)) return true;
  const t = (text || '').toLowerCase();
  if (/unusual traffic from your computer network/i.test(t)) return true;
  if (/verifying you.?re not a bot/i.test(t)) return true;
  if (/checking your browser before accessing/i.test(t)) return true;
  if (/enable javascript and cookies to continue/i.test(t)) return true;
  return false;
}

/**
 * Search via Camoufox. Returns { engine, results } or { error }.
 * @param {string} query
 * @param {object} [opts]
 * @param {string} [opts.proxy]  proxy URL; a residential one unlocks brave
 */
export async function camouSearch(query, opts = {}) {
  const chatId = opts.chatId ?? 0;
  const page = await getPage(chatId);
  const s = _sessions.get(chatId);
  if (opts.proxy && s?.context && s.page) {
    // proxy is set at context level; rebuild the context if it changed
    await s.context.close().catch(() => {});
    const context = await s.browser.newContext({ proxy: { server: opts.proxy } });
    const np = await context.newPage();
    s.context = context;
    s.page = np;
  }

  for (const engine of SEARCH_ENGINES) {
    const url = engine.url(query);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(1500);
    } catch (err) {
      logger.warn({ engine: engine.id, err: err.message }, 'search nav failed, next engine');
      continue;
    }
    if (isBotWall(page.url(), await page.innerText('body').catch(() => ''))) {
      logger.warn({ engine: engine.id }, 'bot wall, next engine');
      continue;
    }

    const results = await extractResults(page, engine.id);
    if (results.length) return { engine: engine.label, results };
    logger.warn({ engine: engine.id }, 'no results parsed, next engine');
  }
  return { error: 'no search engine returned results from this IP — pass a URL to browser_navigate instead' };
}

async function extractResults(page, engineId) {
  // DDG's no-JS page renders as consecutive lines: title, url, snippet —
  // and the url line carries no protocol, so match host-relative links too.
  const text = await page.innerText('body').catch(() => '');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const out = [];

  const looksLikeUrl = (l) =>
    /^https?:\/\//i.test(l) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(l);
  const isJunkUrl = (l) =>
    /duckduckgo\.com|search\.brave\.com|lite\.duckduckgo|w3\.org|schema\.org/i.test(l);

  for (let i = 0; i < lines.length && out.length < 10; i++) {
    const line = lines[i];
    if (!looksLikeUrl(line)) continue;
    if (isJunkUrl(line)) continue;

    // walk back to the nearest non-url line as the title
    let title = '';
    for (let j = i - 1; j >= 0; j--) {
      if (!looksLikeUrl(lines[j])) { title = lines[j]; break; }
    }
    const snippet = lines[i + 1] || '';
    if (title.length <= 3) continue;

    const url = /^https?:/i.test(line) ? line : `https://${line}`;
    out.push({ title, url, snippet });
  }
  return out;
}

/**
 * Browse a URL directly: open, settle, return readable text.
 * @param {string} url
 * @returns {Promise<{title: string, url: string, text: string} | {error: string}>}
 */
export async function camouBrowse(url, { timeoutMs = 40_000, chatId = 0 } = {}) {
  const page = await getPage(chatId);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  } catch (err) {
    return { error: err.message };
  }
  await page.waitForTimeout(1500);
  return {
    title: await page.title().catch(() => ''),
    url: page.url(),
    text: await page.innerText('body').catch(() => ''),
  };
}

export async function camouClose(chatId = 0) {
  await closeBrowser(chatId);
  return 'camoufox closed';
}

export function camoufoxInstalled() {
  return ensureCamoufoxEnv() !== null;
}

