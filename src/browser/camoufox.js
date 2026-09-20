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
// Google stays available to a user with `/browse open`, intentionally not in
// the search chain.
//
// SETUP: Camoufox binaries must be present. The `camou` npm package installs
// them with `camou install`; camoufox-js resolves the same cache once its
// version.json is in the shape it expects (see ensureCamoufoxEnv).

import { launchOptions } from 'camoufox-js';
import { firefox } from 'playwright-core';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../logger.js';

const CAMOUFOX_CACHE = '/root/.cache/camoufox';

/**
 * camoufox-js validates its browser install by reading version.json from the
 * install dir, in its own shape ({release, version}). The `camou` CLI writes a
 * different shape. Rather than patch the library, write the file it expects.
 *
 * @returns {string|null} the browser dir, or null if Camoufox is not installed
 */
export function ensureCamoufoxEnv() {
  // registry written by `camou install` (the camou CLI owns the install dir)
  const registry = join('/root/.local/share/camoucli', 'browsers', 'registry.json');
  if (!existsSync(registry)) return null;

  let version;
  try {
    const reg = JSON.parse(readFileSync(registry, 'utf8'));
    version = reg.currentVersion || Object.keys(reg.installs || {})[0];
  } catch { return null; }
  if (!version) return null;

  const dir = join(CAMOUFOX_CACHE, 'browsers', 'official', version);
  const bin = join(dir, 'camoufox-bin');
  if (!existsSync(bin)) return null;

  // camoufox-js needs this file in its own shape, next to the binary
  const vpath = join(dir, 'version.json');
  const backup = join(dir, 'version.camou.json');
  try {
    const raw = JSON.parse(readFileSync(vpath, 'utf8'));
    if (!raw.release) {
      if (!existsSync(backup)) writeFileSync(backup, JSON.stringify(raw));
      writeFileSync(vpath, JSON.stringify({
        release: raw.release_tag || raw.release_version || raw.version,
        version: (raw.release_version || raw.version || '').split('-')[0],
      }));
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'camoufox version.json fix failed');
    return null;
  }

  // addon downloads fail in this sandbox; skip them entirely
  if (!process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD) {
    process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1';
  }
  return dir;
}

let _browser = null;
let _context = null;
let _page = null;

async function getPage() {
  if (_page) return _page;

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
  _browser = await firefox.launch(opts);
  _context = await _browser.newContext();
  _page = await _context.newPage();
  logger.info('camoufox browser launched (windows fingerprint)');
  return _page;
}

async function closeBrowser() {
  try { await _browser?.close(); } catch {}
  _browser = _context = _page = null;
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
  const page = await getPage();
  if (opts.proxy) {
    // proxy is set at context level; rebuild the context if it changed
    await _context?.close().catch(() => {});
    _context = await _browser.newContext({ proxy: { server: opts.proxy } });
    _page = await _context.newPage();
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
  return { error: 'no search engine returned results from this IP — try /browse open with a specific URL' };
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
export async function camouBrowse(url, { timeoutMs = 40_000 } = {}) {
  const page = await getPage();
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

export async function camouClose() {
  await closeBrowser();
  return 'camoufox closed';
}

export function camoufoxInstalled() {
  return ensureCamoufoxEnv() !== null;
}
