// language: JavaScript (Node 20+ ESM), file: src/agent/tools/browser.js
// Browser tools, Hermes-style: the model drives the browser itself instead of
// a human pasting /browse commands into chat.
//
//   browser_navigate → browser_snapshot → browser_click → browser_read
//
// One Camoufox session per chat (anti-detect Firefox). The snapshot step is
// what makes this reliable: it walks the accessibility tree and hands the model
// stable @eN refs, so click/type aim at real elements instead of a selector the
// model guessed from page text. Refs live in a per-chat map and are rebuilt on
// every snapshot — a ref from two navigations ago is stale and resolved as such.
//
// Why read/click are separate tools: a page is often too large for one context
// window. Snapshot is the compressed map; read pulls the text when the model
// decides it needs it.

import { z } from 'zod';
import { logger } from '../../logger.js';
import { camoufoxInstalled, getPage, camouClose, saveBrowserState } from '../../browser/camoufox.js';
import fs from 'node:fs';
import path from 'node:path';
import { workspaceFor } from '../workspace.js';

const MAX_TEXT = 12 * 1024; // 12 KB of page text per call

// chatId → element array. @eN is the index into this array.
const _refs = new Map();

function refsOf(chatId) {
  if (!_refs.has(chatId)) _refs.set(chatId, []);
  return _refs.get(chatId);
}

/**
 * Resolve a frame by name for read/click/type. A name that matches nothing is
 * an error, never a silent fallthrough to the top document — the model would
 * read the wrong page and not know.
 */
function resolveFrame(page, frame) {
  if (!frame) return page;
  return (
    page.frame?.(frame) ||
    page.frames?.().find((f) => f !== page.mainFrame() && (f.name() === frame || String(f.url()).includes(frame))) ||
    null
  );
}

/** Playwright selector for an @eN ref, or the raw string if it is not a ref. */
function resolveTarget(chatId, target) {
  if (typeof target !== 'string') return { sel: null, err: 'target must be a string' };
  const m = /^@e(\d+)$/.exec(target.trim());
  if (!m) return { sel: target };
  const arr = refsOf(chatId);
  const el = arr[Number(m[1])];
  if (!el) return { sel: null, err: `stale ref ${target} — run browser_snapshot again for fresh refs` };
  return { sel: el.sel };
}

/**
 * Build the interactive-element map for the current page.
 * @returns {Promise<{elements: Array<{role:string,name:string,ref:string}>}>}
 */
async function snapshotPage(chatId) {
  const page = await getPage(chatId);
  const handle = await page.evaluateHandle(() => {
    const INTERACTIVE = new Set([
      'A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'SUMMARY', 'LABEL',
    ]);
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      const el = node;
      const tag = el.tagName;
      const role = el.getAttribute('role');
      const clickable = INTERACTIVE.has(tag)
        || role === 'button' || role === 'link'
        || el.hasAttribute('onclick')
        || (el.tabIndex !== undefined && el.tabIndex > 0 && !/^H[1-6]$/.test(tag));
      if (!clickable) continue;
      const text = (el.innerText || el.textContent || el.getAttribute('aria-label')
        || el.getAttribute('title') || el.getAttribute('placeholder') || el.value || '').trim();
      // skip invisible elements — they are not clickable in practice
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const name = text.replace(/\s+/g, ' ').slice(0, 60);
      out.push({
        tag: tag.toLowerCase(),
        role: role || tag.toLowerCase(),
        name,
        // a path the model and the click can both aim at
        sel: el.id ? `#${el.id}` : null,
        text: name,
      });
    }
    return out;
  });

  const raw = await handle.jsonValue().catch(() => []);
  await handle.dispose().catch(() => {});

  // Playwright's accessibility roles do not match tag names one-to-one:
  // <a> is role "link" in Playwright, "a" in the DOM. Map the common ones so
  // role= selectors resolve through the same tree the snapshot walked.
  const PLAYWRIGHT_ROLE = { a: 'link', button: 'button', input: 'textbox', textarea: 'textbox', select: 'combobox', summary: 'button', label: 'group' };
  const arr = [];
  for (const e of raw) {
    const role = PLAYWRIGHT_ROLE[e.role] || e.role;
    arr.push({
      role,
      name: e.text,
      sel: e.sel || `role=${role}[name="${(e.text || '').replace(/"/g, '\\"')}"]`,
    });
  }
  _refs.set(chatId, arr);
  return arr;
}

// ---------------------------------------------------------------- navigate

const navigateSchema = z.object({
  url: z.string().url(),
});

export const browserNavigate = {
  name: 'browser_navigate',
  description: 'Open a URL in the browser and return the page title and first lines of text. Use browser_snapshot for the element map, browser_read for full text. Read-only.',
  isDangerous: false,
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', description: 'Full URL including https://' } },
    required: ['url'],
    additionalProperties: false,
  },
  schema: navigateSchema,
  async execute({ url }, ctx = {}) {
    const chatId = ctx.chatId ?? 0;
    if (!camoufoxInstalled()) {
      return '⚠️ Camoufox is not installed on this server. The operator must run `npx camou install` once.';
    }
    logger.info({ chatId, url: url.slice(0, 120) }, 'browser_navigate');
    const page = await getPage(chatId);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 });
      await page.waitForTimeout(1500); // let JS settle
    } catch (err) {
      return `⚠️ navigation failed: ${err.message}`;
    }
    const title = await page.title().catch(() => '');
    const preview = (await page.innerText('body').catch(() => ''))
      .replace(/\s+/g, ' ').trim().slice(0, 600);
    return `✅ ${title}\n${page.url()}\n\n${preview}${preview.length >= 600 ? '…' : ''}\n\nCall browser_snapshot for interactive elements.`;
  },
};

// ---------------------------------------------------------------- read

const readSchema = z.object({
  selector: z.string().optional(),
  max_chars: z.number().int().positive().max(20_000).optional(),
  frame: z.string().optional(),
});

export const browserRead = {
  name: 'browser_read',
  description: 'Return the text of the current page, or of one element. Read-only — the safe way to see page contents.',
  isDangerous: false,
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'Optional: restrict to one element (@eN ref or selector)' },
      max_chars: { type: 'number', description: 'Cap on returned characters (default 12000)' },
      frame: { type: 'string', description: 'Optional: an iframe name from browser_tabs (frames) — reads inside that frame instead of the top document' },
    },
    required: [],
    additionalProperties: false,
  },
  schema: readSchema,
  async execute({ selector, max_chars, frame }, ctx = {}) {
    const chatId = ctx.chatId ?? 0;
    const cap = max_chars ?? MAX_TEXT;
    const page = await getPage(chatId);
    if (!page) return '⚠️ no browser session for this chat — call browser_navigate first';
    // A frame name swaps the document being read. An unknown name is an error,
    // not a silent read of the top page — that would look like a success.
    const doc = resolveFrame(page, frame);
    if (!doc) return `⚠️ no iframe named or matching "${frame}" on this page`;
    if (!selector) {
      const text = (await doc.innerText('body').catch(() => ''))
        .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      return text.slice(0, cap) + (text.length > cap ? `\n\n…[truncated, ${text.length - cap} chars left — call again with a selector to read the rest]` : '');
    }
    const t = resolveTarget(chatId, selector);
    if (t.err) return `⚠️ ${t.err}`;
    const text = await doc.locator(t.sel).innerText().catch(() => '');
    return String(text).slice(0, cap);
  },
};

// ---------------------------------------------------------------- snapshot

export const browserSnapshot = {
  name: 'browser_snapshot',
  description: 'List every clickable element on the current page as @eN refs. Call this before browser_click or browser_type. Read-only.',
  isDangerous: false,
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  schema: z.object({}),
  async execute(_args, ctx = {}) {
    const chatId = ctx.chatId ?? 0;
    const arr = await snapshotPage(chatId);
    if (!arr.length) return 'No interactive elements on this page.';
    const lines = arr.slice(0, 80).map((e, i) => {
      const name = e.name ? ` "${e.name}"` : '';
      return `${e.role}${name} @e${i}`;
    });
    return `✅ ${arr.length} interactive element(s) (use @eN with browser_click / browser_type):\n${lines.join('\n')}`;
  },
};

// ---------------------------------------------------------------- click

const clickSchema = z.object({
  target: z.string().min(1),
  frame: z.string().optional(),
});

export const browserClick = {
  name: 'browser_click',
  description: 'Click an element on the current page. Takes an @eN ref from browser_snapshot, or a Playwright selector. This performs a real action on the site — think before you click.',
  isDangerous: true, // it mutates state on a remote site: submit, buy, delete, post
  parameters: {
    type: 'object',
    properties: { target: { type: 'string', description: '@eN ref or a Playwright selector' } },
    required: ['target'],
    additionalProperties: false,
  },
  schema: clickSchema,
  async execute({ target, frame }, ctx = {}) {
    const chatId = ctx.chatId ?? 0;
    const t = resolveTarget(chatId, target);
    if (t.err) return `⚠️ ${t.err}`;
    const page = await getPage(chatId);
    const doc = resolveFrame(page, frame);
    if (!doc) return `⚠️ no iframe named or matching "${frame}" on this page`;
    try {
      await doc.locator(t.sel).first().click({ timeout: 15_000 });
    } catch (err) {
      return `⚠️ click failed: ${err.message}\nRun browser_snapshot again — the page may have changed since.`;
    }
    await page.waitForTimeout(800);
    const title = await page.title().catch(() => '');
    const preview = (await page.innerText('body').catch(() => ''))
      .replace(/\s+/g, ' ').trim().slice(0, 300);
    _refs.delete(chatId); // the page changed; refs from before the click are stale
    return `✅ clicked; now on "${title}" (${page.url()})\n${preview}`;
  },
};

// ---------------------------------------------------------------- type

const typeSchema = z.object({
  target: z.string().min(1),
  text: z.string().max(4000),
  submit: z.boolean().optional(),
  frame: z.string().optional(),
});

export const browserType = {
  name: 'browser_type',
  description: 'Type text into a form field on the current page. Takes an @eN ref from browser_snapshot, or a selector. Set submit:true to press Enter afterwards. This mutates a remote form.',
  isDangerous: true, // it fills and can submit a real form
  parameters: {
    type: 'object',
    properties: {
      target: { type: 'string', description: '@eN ref or a Playwright selector of the input field' },
      text: { type: 'string', description: 'The text to type' },
      submit: { type: 'boolean', description: 'Press Enter after typing (default false)' },
    },
    required: ['target', 'text'],
    additionalProperties: false,
  },
  schema: typeSchema,
  async execute({ target, text, submit }, ctx = {}) {
    const chatId = ctx.chatId ?? 0;
    const t = resolveTarget(chatId, target);
    if (t.err) return `⚠️ ${t.err}`;
    const page = await getPage(chatId);
    try {
      const loc = page.locator(t.sel).first();
      await loc.fill(text, { timeout: 15_000 });
      if (submit) await loc.press('Enter');
    } catch (err) {
      return `⚠️ type failed: ${err.message}`;
    }
    await page.waitForTimeout(500);
    return `✅ typed into ${target}${submit ? ' and pressed Enter' : ''}`;
  },
};

// ---------------------------------------------------------------- search

const searchSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().positive().max(10).optional(),
});

export const browserSearch = {
  name: 'browser_search',
  description: 'Search the web through the anti-detect browser and return results (title, URL, snippet). Engines fall back automatically when one blocks this IP. Read-only.',
  isDangerous: false,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      limit: { type: 'number', description: 'Max results (default 6)' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  schema: searchSchema,
  async execute({ query, limit }, ctx = {}) {
    const chatId = ctx.chatId ?? 0;
    if (!camoufoxInstalled()) {
      return '⚠️ Camoufox is not installed on this server. The operator must run `npx camou install` once.';
    }
    const { camouSearch } = await import('../../browser/camoufox.js');
    logger.info({ chatId, q: query.slice(0, 80) }, 'browser_search');
    const r = await camouSearch(query, { chatId });
    if (r.error) return `⚠️ ${r.error}`;
    const n = limit ?? 6;
    const lines = r.results.slice(0, n).map(
      (x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`.trim()
    );
    return `🔍 ${r.engine} — "${query}"\n\n${lines.join('\n\n')}`;
  },
};

// ---------------------------------------------------------------- close

export const browserClose = {
  name: 'browser_close',
  description: 'Close the browser session for this chat. Frees memory; call browser_navigate to start again.',
  isDangerous: false,
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  schema: z.object({}),
  async execute(_args, ctx = {}) {
    const chatId = ctx.chatId ?? 0;
    await camouClose(chatId);
    _refs.delete(chatId);
    return '✅ browser session closed';
  },
};

// ---------------------------------------------------------------- download

const downloadSchema = z.object({
  url: z.string().url().min(1),
  filename: z.string().min(1).max(200).optional(),
  wait_ms: z.number().int().positive().max(120_000).optional(),
});

export const browserDownload = {
  name: 'browser_download',
  description:
    'Download a file through the anti-detect browser session — the URL is fetched as the logged-in user, with their cookies and fingerprint, which plain fetch_url cannot do. Saves to the workspace and returns the path. Read-only to the site, but the file lands on disk: verify what you asked for.',
  isDangerous: false,
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The file URL' },
      filename: { type: 'string', description: 'Name to save as (default: from the URL path)' },
      wait_ms: { type: 'number', description: 'Max wait for the download to finish (default 60000)' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  schema: downloadSchema,
  async execute({ url, filename, wait_ms = 60_000 }, ctx = {}) {
    const chatId = ctx.chatId ?? 0;
    const page = await getPage(chatId);
    const outDir = path.join(workspaceFor(ctx.userId ?? ctx.chatId), 'downloads');
    try { fs.mkdirSync(outDir, { recursive: true }); } catch {}

    const name = filename || new URL(url).pathname.split('/').filter(Boolean).pop() || 'download.bin';
    const dest = path.join(outDir, name);

    // Playwright's download event is the only reliable way: a direct fetch would
    // drop the session cookies that make the URL downloadable at all.
    try {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: wait_ms }),
        page.goto(url),
      ]);
      await download.saveAs(dest);
      const stat = fs.statSync(dest);
      return `✅ saved ${name} (${Math.round(stat.size / 1024)} KB) to workspace/downloads/${name}`;
    } catch (err) {
      // Not every URL triggers a download event — some serve bytes directly.
      // Fall back to saving the response body, still inside the browser session.
      try {
        const buf = await page.goto(url).then((r) => r?.body());
        if (buf && buf.length) {
          fs.writeFileSync(dest, buf);
          return `✅ saved ${name} (${Math.round(buf.length / 1024)} KB, direct) to workspace/downloads/${name}`;
        }
      } catch (e2) { /* fall through to the original error */ }
      return `⚠️ download failed: ${err.message}`;
    }
  },
};

// ---------------------------------------------------------------- auth state

const authSchema = z.object({
  action: z.enum(['save', 'clear', 'status']),
});

export const browserAuth = {
  name: 'browser_auth',
  description:
    'Persist or inspect the browser session credentials. save: snapshot cookies + localStorage to disk, so a login survives a browser restart and the next browser_navigate starts signed in. clear: drop the saved state (logs out). status: whether a saved state exists. The state is per-chat, stored under data/, never in the workspace.',
  isDangerous: false,
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['save', 'clear', 'status'], description: 'save: persist now. clear: drop it. status: does one exist' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  schema: authSchema,
  async execute({ action }, ctx = {}) {
    const chatId = ctx.chatId ?? 0;
    const stateFile = path.join(process.cwd(), 'data', 'browser-state', `state-${chatId}.json`);
    if (action === 'status') {
      const exists = fs.existsSync(stateFile);
      return exists ? `a saved session exists for this chat (${Math.round(fs.statSync(stateFile).size / 1024)} KB). browser_navigate restores it automatically.` : 'no saved session — the browser starts logged out.';
    }
    if (action === 'clear') {
      try { fs.unlinkSync(stateFile); } catch {}
      return '✅ saved session cleared — the next browser session starts logged out.';
    }
    // save
    const ok = await saveBrowserState(chatId);
    return ok
      ? '✅ session saved — cookies and localStorage persist across browser restarts.'
      : '⚠️ no live browser session to save. Navigate and log in first.';
  },
};

export const browserTools = [
  browserNavigate,
  browserRead,
  browserSnapshot,
  browserClick,
  browserType,
  browserSearch,
  browserDownload,
  browserAuth,
  browserClose,
];
