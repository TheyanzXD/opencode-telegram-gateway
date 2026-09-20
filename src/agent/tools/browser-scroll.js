// language: JavaScript (Node 20+ ESM), file: src/agent/tools/browser-scroll.js
// browser_scroll — move through a page, and hand back landmarks to jump to.
//
// browser_read returns the whole body, capped. On an infinite-feed page or a
// long table the interesting part is 4000 px below the fold and the cap eats
// it before the model sees it — and nothing in the base tool set can scroll at
// all, so lazy-loaded content never arrives.
//
// This tool scrolls (by pixels, by pages, or to an element), returns the new
// viewport position, and — the part that makes it useful — lists the page's
// landmarks as @sN refs the model can jump to in one call. Headings and
// section roots are stable across resizes in a way pixel offsets are not.
//
// Read-only. Scroll position is local browser state, not a change to the site.

import { z } from 'zod';
import { logger } from '../../logger.js';
import { setRefList, truncate } from './browser-refs.js';

const MAX_LANDMARKS = 40;
const MAX_TEXT = 6000;

const scrollSchema = z.object({
  direction: z.enum(['up', 'down']).optional(),
  amount_px: z.number().int().min(1).max(20_000).optional(),
  pages: z.number().int().min(1).max(20).optional(),
  to: z.string().max(300).optional(),
  landmarks: z.boolean().optional(),
});

/**
 * @param {object} args
 * @param {'up'|'down'} [args.direction]  scroll direction (default 'down')
 * @param {number} [args.amount_px]       pixels to scroll (default 600)
 * @param {number} [args.pages]           viewport heights to scroll (overrides amount_px)
 * @param {string} [args.to]              an @sN landmark ref, or a selector, to scroll into view
 * @param {boolean} [args.landmarks]      include the landmark list in the result (default true)
 */
export const browserScroll = {
  name: 'browser_scroll',
  description:
    'Scroll the page up or down, or jump to an element. Reports the new scroll position and the page\'s landmarks as @sN refs (headings and section roots) you can pass back as to:"@sN" to jump straight to one. Use it when browser_read is truncated or when content loads as you scroll. Add browser_wait({ selector }) after scrolling — lazy content is not in the DOM until the scroll lands. Read-only.',
  isDangerous: false, // scroll position is local; the remote site cannot observe it
  parameters: {
    type: 'object',
    properties: {
      direction: { type: 'string', enum: ['up', 'down'], description: 'Which way (default "down")' },
      amount_px: { type: 'number', description: 'Pixels to scroll (default 600, max 20000)' },
      pages: { type: 'number', description: 'Viewport heights to scroll (overrides amount_px)' },
      to: { type: 'string', description: 'Scroll an element into view: an @sN landmark ref, or a Playwright selector.' },
      landmarks: { type: 'boolean', description: 'Include the landmark list in the result (default true)' },
    },
    required: [],
    additionalProperties: false,
  },
  scroll_progress: true, // progress hint for the engine's status line
  schema: scrollSchema,
  async execute({ direction, amount_px, pages, to, landmarks }, ctx = {}) {
    const chatId = ctx.chatId ?? 0;
    const { getPage, sessionActive } = await import('../../browser/camoufox.js');
    if (!sessionActive(chatId)) {
      return '⚠️ no browser session for this chat — call browser_navigate first';
    }
    const page = await getPage(chatId);
    if (!page || page.isClosed?.()) return '⚠️ the browser page is closed — call browser_navigate first';

    // ---------------------------------------------- collect landmarks first
    // Collected before the scroll so a `to` ref from a previous call still
    // resolves against the same list this call is about to replace.
    const lm = landmarks !== false
      ? await collectLandmarks(page).catch(() => [])
      : [];
    const labelled = setRefList(chatId, 'scroll', lm);
    if (to) {
      const hit = labelled.find((l) => l.ref === to);
      if (hit) {
        await page.locator(hit.sel).first().scrollIntoViewIfNeeded({ timeout: 10_000 }).catch((err) => {
          throw new Error(`scrollIntoView failed: ${err.message}`);
        });
        return formatResult(page, labelled, `jumped to ${to} ("${hit.name.slice(0, 50)}")`, lm);
      }
      // not a ref: treat as a selector
      try {
        await page.locator(to).first().scrollIntoViewIfNeeded({ timeout: 10_000 });
        return formatResult(page, labelled, `scrolled "${to}" into view`, lm);
      } catch (err) {
        return `⚠️ ${err.message}\nPass landmarks:true (or omit "to") to list valid @sN refs.`;
      }
    }

    const dir = direction === 'up' ? -1 : 1;
    let delta;
    if (pages) {
      const vh = await page.evaluate(() => window.innerHeight || 800);
      delta = dir * Math.max(1, pages) * vh;
    } else {
      delta = dir * (Math.min(Math.max(Number(amount_px) || 600, 1), 20_000));
    }
    await page.evaluate((d) => window.scrollBy(0, d), delta).catch((err) => {
      throw new Error(`scroll failed: ${err.message}`);
    });
    await page.waitForTimeout(300);
    logger.info({ chatId, delta }, 'browser_scroll');
    return formatResult(page, labelled, `scrolled ${dir > 0 ? 'down' : 'up'} ${Math.abs(delta)} px`, lm);
  },
};

/** Headings and section roots, with their distance below the top of the page. */
async function collectLandmarks(page) {
  return page.evaluate(() => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        const tag = el.tagName;
        if (/^H[1-6]$/.test(tag)) return NodeFilter.FILTER_ACCEPT;
        const role = el.getAttribute('role');
        if (role === 'heading') return NodeFilter.FILTER_ACCEPT;
        if (el.tagName === 'SECTION' || el.tagName === 'MAIN' || el.tagName === 'NAV'
          || el.tagName === 'ARTICLE' || el.tagName === 'ASIDE') return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_SKIP;
      },
    });
    let node;
    while ((node = walker.nextNode()) && out.length < 40) {
      const el = node;
      const r = el.getBoundingClientRect();
      const name = (el.innerText || el.textContent || el.getAttribute('aria-label') || '')
        .trim().replace(/\s+/g, ' ').slice(0, 60);
      out.push({
        level: /^H(\d)$/.test(el.tagName) ? Number(RegExp.$1) : 0,
        name,
        y: Math.round(r.top + window.scrollY),
        sel: el.id ? `#${el.id}` : null,
      });
    }
    return out;
  });
}

async function formatResult(page, labelled, what, lm) {
  const pos = await page.evaluate(() => ({
    x: Math.round(window.scrollX),
    y: Math.round(window.scrollY),
    vh: window.innerHeight || 0,
    docH: document.documentElement.scrollHeight || 0,
  }));
  const pct = pos.docH > pos.vh ? Math.min(100, Math.round((pos.y / (pos.docH - pos.vh)) * 100)) : 100;
  const head = `✅ ${what} — scroll y=${pos.y}, ${pct}% down the page (${pos.docH}px total)`;
  if (!labelled.length) return head;
  const lines = labelled.map((l) => `${'  '.repeat(Math.min(l.level, 4))}${l.name || '(unnamed)'} @${l.ref} (y=${l.y})`);
  return `${head}\n\nLandmarks:\n${truncate(lines.join('\n'), MAX_TEXT)}`;
}