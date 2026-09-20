// language: JavaScript (Node 20+ ESM), file: src/agent/tools/browser-tabs.js
// browser_tabs — multi-tab and iframe navigation for the base tool set.
//
// camoufox.js gives every chat one page. browser_navigate reuses it, which means
// "open these three results and compare them" is either three sequential
// navigations (the first two pages are gone by the time the model reads the
// third) or a stream of fetches without a browser at all. This tool adds the
// missing dimension: new tabs, switching between them, and closing them.
//
// The same gap exists for iframes. A page's snapshot is built from the top-level
// document; an iframe's contents are a separate document that Playwright needs a
// Frame object — not a Page — to touch. browser_snapshot cannot reach them, so
// this tool hands the model a way in: a frame name it can pass back to
// browser_read/browser_click, which Playwright resolves from any frame on the page.
//
// Tabs are created lazily, one per call, and closed on browser_close along with
// the rest of the session. Tab switching is a real side effect — switching to a
// tab changes what every read-only browser tool sees next — but it does not
// touch any remote site, so it stays read-only.

import { z } from 'zod';
import { logger } from '../../logger.js';
import { getHandles, setHandles, truncate } from './browser-refs.js';

// The camoufox module owns the page; reach into it for the context only.
const CONTEXT = () => import('../../browser/camoufox.js');

const tabSchema = z.object({
  action: z.enum(['list', 'new', 'switch', 'close', 'frames']),
  url: z.string().url().max(2000).optional(),
  index: z.number().int().nonnegative().max(50).optional(),
});

/**
 * @param {object} args
 * @param {'list'|'new'|'switch'|'close'|'frames'} args.action
 * @param {string} [args.url]     for new: the URL to open (about:blank if omitted)
 * @param {number} [args.index]   for switch/close: which tab, from the list output
 */
export const browserTabs = {
  name: 'browser_tabs',
  description:
    'Manage browser tabs and list a page\'s iframes. "list" shows every open tab as @wN refs with its title and URL. "new" opens one (optionally at a URL — omit it for a blank tab). "switch" makes another tab the one every other browser tool sees. "close" closes one, or the current tab when no index is given. "frames" lists the page\'s iframes as names to pass to browser_read/browser_click/browser_form with a frame=<name> argument. Use this to compare several pages at once, or to reach content an iframe holds that browser_snapshot cannot see.',
  isDangerous: false, // tab bookkeeping touches the local browser, not the remote site
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'new', 'switch', 'close', 'frames'],
        description: 'list | new | switch | close | frames',
      },
      url: { type: 'string', description: 'For action "new": the URL to open. Omit for a blank tab.' },
      index: { type: 'number', description: 'For switch/close: the tab index from the list output (0-based).' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  schema: tabSchema,
  async execute({ action, url, index }, ctx = {}) {
    const chatId = ctx.chatId ?? 0;
    const { getPage, sessionActive } = await CONTEXT();
    if (!sessionActive(chatId)) {
      return '⚠️ no browser session for this chat — call browser_navigate first';
    }
    const page = await getPage(chatId);
    if (!page || page.isClosed?.()) return '⚠️ the browser page is closed — call browser_navigate first';

    // -------------------------------------------------------------- frames
    if (action === 'frames') {
      const frames = page.frames().filter((f) => f !== page.mainFrame());
      if (!frames.length) return 'This page has no iframes.';
      const lines = frames.map((f, i) => {
        const name = f.name() || `(unnamed #${i})`;
        const url_now = f.url().slice(0, 100);
        return `${name} — ${url_now}`;
      });
      return `✅ ${frames.length} iframe(s). Pass its name as the frame argument to browser_read / browser_click / browser_form:\n${lines.join('\n')}`;
    }

    // ---------------------------------------------------------------- tabs
    const context = page.context();
    const pages = context.pages();
    const handles = pages.map((p) => ({ id: p.__tabId, url: p.url(), title: '' }));
    setHandles(chatId, handles);

    if (action === 'list') {
      if (pages.length <= 1) return 'Only one tab is open. Use action "new" to open another.';
      const titles = await Promise.all(pages.map((p) => p.title().catch(() => '')));
      const lines = pages.map((p, i) => {
        const mark = p === page ? ' ← current' : '';
        return `@w${i} ${titles[i] || '(untitled)'}\n    ${p.url().slice(0, 120)}${mark}`;
      });
      return `✅ ${pages.length} tabs open (index with @wN or the numeric index):\n${lines.join('\n\n')}`;
    }

    if (action === 'new') {
      const np = await context.newPage();
      np.__tabId = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      if (url) {
        try {
          await np.goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 });
          await np.waitForTimeout(1000);
        } catch (err) {
          return `⚠️ new tab opened, but navigation failed: ${err.message}`;
        }
      }
      const idx = context.pages().indexOf(np);
      const title = await np.title().catch(() => '');
      logger.info({ chatId, idx, url: String(url || 'about:blank').slice(0, 80) }, 'browser_tabs new');
      return `✅ new tab @w${idx}: "${title}" — ${np.url()}\nIt is now the current tab.`;
    }

    if (action === 'switch' || action === 'close') {
      const pagesNow = context.pages();
      let target = page;
      if (index !== undefined && index !== null) {
        const t = pagesNow[index];
        if (!t) return `⚠️ no tab at index ${index} — ${pagesNow.length} tab(s) open (0–${pagesNow.length - 1})`;
        target = t;
      }
      if (action === 'switch') {
        if (target === page) return 'That tab is already current.';
        await target.bringToFront().catch(() => {});
        const title = await target.title().catch(() => '');
        return `✅ switched to @w${pagesNow.indexOf(target)}: "${title}" — ${target.url()}`;
      }
      // close: never close the last tab — that ends the session and every other
      // browser tool would fail with "page is closed" on the next call
      if (pagesNow.length <= 1) {
        return '⚠️ this is the last tab — close the session with browser_close instead';
      }
      const wasCurrent = target === page;
      const idx = pagesNow.indexOf(target);
      await target.close().catch(() => {});
      const remaining = context.pages();
      // a closed tab leaves the session without a current page until something
      // brings one forward; do it here so the read-only tools keep working
      if (wasCurrent) await remaining[0].bringToFront().catch(() => {});
      logger.info({ chatId, idx }, 'browser_tabs close');
      return `✅ closed @w${idx}${wasCurrent ? ' (was current — switched to @w0)' : ''}. ${remaining.length} tab(s) left.`;
    }

    return `⚠️ unknown action: ${action}`;
  },
};
