// language: JavaScript (Node 20+ ESM), file: src/browser/stealth.js
// Anti-detection init script + realistic UA rotation.
//
// Why: this VPS sits on a datacenter IP. Plain headless Chromium announces
// itself as HeadlessChrome and sets navigator.webdriver=true; the first is a
// flag, the second is a hard fail on every bot-detection checklist. Google
// redirects to /sorry on sight. Fixing the fingerprint does not fix the IP, but
// it removes the cheap automatic rejections — the ones a real browser on the
// same IP would not get.
//
// What this does NOT do: it cannot defeat Cloudflare's managed challenge or a
// captcha wall that evaluates behaviour and IP reputation. Those need a
// residential proxy (PROXY_PREMIUM_FILE) or a cloud browser provider.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { logger } from '../logger.js';

// A handful of current, plausible desktop UAs. Rotating per session is enough —
// a single UA reused forever is its own fingerprint.
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

export function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// The init script itself. Runs before page JS, so the lies are in place before
// any detection script reads them.
const STEALTH_SCRIPT = `// navigator.webdriver: the single loudest headless tell.
Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
Object.defineProperty(Object.getPrototypeOf(navigator), 'webdriver', { get: () => undefined, configurable: true });

// plugins: headless reports an empty PluginArray; real Chrome has 5 entries
// and the array must be of type PluginArray for the instanceof check.
Object.defineProperty(navigator, 'plugins', { get: () => {
  const arr = [1, 2, 3, 4, 5];
  arr.item = () => arr[0];
  arr.namedItem = () => arr[0];
  arr.refresh = () => {};
  Object.defineProperty(arr, 'length', { value: 5 });
  Object.setPrototypeOf(arr, PluginArray.prototype);
  return arr;
}, configurable: true });

Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });

// window.chrome: missing entirely in headless; present in every real Chrome
window.chrome = window.chrome || { runtime: {}, app: {}, csi: () => {}, loadTimes: () => {} };

// WebGL vendor/renderer: headless reports SwiftShader, which is a headless tell
const _gp = WebGLRenderingContext.prototype.getParameter;
WebGLRenderingContext.prototype.getParameter = function (p) {
  if (p === 37445) return 'Intel Inc.';
  if (p === 37446) return 'Intel Iris OpenGL Engine';
  return _gp.call(this, p);
};

// iframe contentWindow must also see window.chrome, or the iframe check fails
const _cw = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
if (_cw && _cw.get) {
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    get() { const w = _cw.get.call(this); if (w) try { w.chrome = window.chrome; } catch {} return w; },
    configurable: true,
  });
}

// permissions: headless reports 'prompt' where Chrome reports 'granted'
if (navigator.permissions && navigator.permissions.query) {
  const _q = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = (p) => p && p.name === 'notifications'
    ? Promise.resolve({ state: 'granted', onchange: null })
    : _q(p);
}
`;

let _scriptPath;

/**
 * Write the stealth init script to a temp file once and return the path.
 * agent-browser's --init-script takes a file path, not source.
 */
export function stealthScriptPath() {
  if (_scriptPath) return _scriptPath;
  const dir = join(tmpdir(), 'otg-browser');
  try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
  _scriptPath = join(dir, 'stealth.js');
  writeFileSync(_scriptPath, STEALTH_SCRIPT, 'utf8');
  logger.debug({ path: _scriptPath }, 'stealth init script staged');
  return _scriptPath;
}

/**
 * Assemble the anti-detection flags for an agent-browser invocation.
 * @param {object} [opts]
 * @param {string} [opts.userAgent]  pin a UA (e.g. for session continuity)
 * @param {string} [opts.proxy]      proxy URL from the pool
 * @returns {string[]} flags to spread into the argv
 */
export function stealthFlags(opts = {}) {
  const flags = ['--init-script', stealthScriptPath()];
  flags.push('--user-agent', opts.userAgent || randomUserAgent());
  if (opts.proxy) flags.push('--proxy', opts.proxy);
  return flags;
}
