// language: JavaScript (Node 20+ ESM), file: src/agent/tools/browser-wait.js
// browser_wait — the timing primitive the base tool set is missing.
//
// The base tools fire and read. That works when the page is already there and
// fails on everything dynamic: a spinner that has to clear, a table that
// arrives three seconds after the click, a "Saved ✓" that must appear before
// the model claims success. The only lever those tools offer is a fixed sleep,
// which is both slow (you guess high) and racy (you guess low).
//
// This tool waits for a *condition*: URL change, a selector appearing or
// vanishing, a network request count going quiet, or text showing up. It has a
// hard timeout so a missing element costs one tool call instead of a hung turn.
//
// Read-only: waiting observes the page, it does not touch it.

import { z } from 'zod';
import { logger } from '../../logger.js';
import { truncate } from './browser-refs.js';

const MAX_CONDITIONS = 3;
const MAX_TEXT = 4000;
const MIN_TIMEOUT = 1000;
const MAX_TIMEOUT = 60_000;

// --------------------------------------------------------------- conditions

/** A URL (substring or RegExp source) tested against the page location. */
function test_url(page, value) {
  const v = String(value || '').trim();
  if (!v) return { err: 'url condition needs a value' };
  return {
    check: async () => {
      const cur = page.url();
      // a value wrapped in /…/ is a regex source; anything else is a substring
      if (v.startsWith('/') && v.endsWith('/') && v.length > 2) {
        return new RegExp(v.slice(1, -1), 'i').test(cur);
      }
      return cur.includes(v);
    },
    label: `url contains ${v}`,
  };
}

/** A selector that must be present (or, with until:"gone", must be absent). */
function test_selector(page, value, until) {
  const v = String(value || '').trim();
  if (!v) return { err: 'selector condition needs a value' };
  const wantGone = until === 'gone';
  return {
    check: async () => {
      const count = await page.locator(v).count().catch(() => 0);
      return wantGone ? count === 0 : count > 0;
    },
    label: `${wantGone ? 'absence of' : 'presence of'} ${v}`,
  };
}

/** Text (or a /regex/) that must appear in (or vanish from) the body. */
function test_text(page, value, until) {
  const v = String(value || '');
  if (!v) return { err: 'text condition needs a value' };
  const wantGone = until === 'gone';
  const re = v.startsWith('/') && v.endsWith('/') && v.length > 2
    ? new RegExp(v.slice(1, -1), 'i')
    : null;
  return {
    check: async () => {
      const body = await page.innerText('body').catch(() => '');
      const hit = re ? re.test(body) : body.includes(v);
      return wantGone ? !hit : hit;
    },
    label: `${wantGone ? 'absence of' : 'presence of'} text ${re ? v : `"${v.slice(0, 40)}"`}`,
  };
}

/**
 * Network quiet: no matching request for N ms. Expensive to poll via
 * page.on('request'), so it snapshots the request counter once at the start
 * and then looks for activity — a page that is truly done stops ticking.
 */
function test_network(page, value) {
  const quietMs = Math.min(Math.max(Number(value) || 1500, 500), 10_000);
  let lastTick = Date.now();
  let total = 0;
  const onReq = () => { total += 1; lastTick = Date.now(); };
  page.on('request', onReq);
  const started = Date.now();
  return {
    check: async () => Date.now() - started > 2000 && Date.now() - lastTick >= quietMs,
    label: `network quiet for ${quietMs} ms`,
    teardown: () => page.off('request', onReq),
  };
}

/**
 * Wait until *all* conditions hold. Polling, not an event-driven wait, because
 * the conditions are mixed (URL, DOM, network) and a poll loop is one code path
 * instead of four — at 200 ms it is indistinguishable from instant.
 *
 * @returns {Promise<{met: boolean, elapsed: number, detail: string}>}
 */
async function waitForConditions(page, conds, timeoutMs) {
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  const labels = conds.map((c) => c.label);
  let last = null;

  for (;;) {
    const now = Date.now();
    if (now >= deadline) {
      conds.forEach((c) => c.teardown?.());
      return { met: false, elapsed: now - t0, detail: `timed out after ${now - t0} ms waiting for ${labels.join(' + ')}` };
    }
    const results = await Promise.all(conds.map((c) => Promise.resolve(c.check().then(
      (ok) => (ok === true ? null : c.label),
      () => c.label
    ))));
    const failed = results.filter(Boolean);
    if (!failed.length) {
      conds.forEach((c) => c.teardown?.());
      return { met: true, elapsed: now - t0, detail: `met in ${now - t0} ms` };
    }
    if (failed.join('|') !== last) last = failed.join('|');
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ------------------------------------------------------------------ the tool

const waitSchema = z.object({
  url: z.string().max(500).optional(),
  selector: z.string().max(300).optional(),
  text: z.string().max(2000).optional(),
  network_quiet_ms: z.number().int().positive().max(10_000).optional(),
  until: z.enum(['appear', 'gone']).optional(),
  timeout_ms: z.number().int().positive().max(MAX_TIMEOUT).optional(),
});

/**
 * @param {object} args
 * @param {string} [args.url]             wait for the URL to contain this (or /regex/)
 * @param {string} [args.selector]        wait for this selector to appear (or vanish)
 * @param {string} [args.text]            wait for this text (or /regex/) in the body
 * @param {number} [args.network_quiet_ms] wait until no request lands for this long
 * @param {'appear'|'gone'} [args.until]  'gone' inverts selector/text (default 'appear')
 * @param {number} [args.timeout_ms]      hard cap, default 15000, max 60000
 */
export const browserWait = {
  name: 'browser_wait',
  description:
    'Wait for the page to reach a state instead of guessing a sleep: until the URL changes, a selector appears or disappears, text shows up or is removed, or the network goes quiet (no requests for N ms). Conditions AND together when several are given. Returns as soon as they are met, or after timeout_ms (default 15 s) with what did not happen. Read-only. Use after browser_click or browser_type on pages that load their content dynamically.',
  isDangerous: false, // observation only — it never touches the page
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Wait for the page URL to contain this string, or match this /regex/.' },
      selector: { type: 'string', description: 'Wait for this Playwright selector to appear (or, with until:"gone", to disappear).' },
      text: { type: 'string', description: 'Wait for this text to appear in the page body (or, with until:"gone", to be gone). A /regex/ is matched.' },
      network_quiet_ms: { type: 'number', description: 'Additionally require no network request for this many milliseconds (500–10000).' },
      until: { type: 'string', enum: ['appear', 'gone'], description: 'Invert selector/text conditions (default "appear")' },
      timeout_ms: { type: 'number', description: 'Give up after this many milliseconds (default 15000, max 60000)' },
    },
    required: [],
    additionalProperties: false,
  },
  schema: waitSchema,
  async execute(args, ctx = {}) {
    const chatId = ctx.chatId ?? 0;
    const { getPage, sessionActive } = await import('../../browser/camoufox.js');
    if (!sessionActive(chatId)) {
      return '⚠️ no browser session for this chat — call browser_navigate first';
    }
    const page = await getPage(chatId);
    if (!page || page.isClosed?.()) return '⚠️ the browser page is closed — call browser_navigate first';

    const { url, selector, text, network_quiet_ms, until, timeout_ms } = args;
    const timeout = Math.min(Math.max(Number(timeout_ms) || 15_000, MIN_TIMEOUT), MAX_TIMEOUT);

    const conds = [];
    const errs = [];
    if (url) {
      const c = test_url(page, url);
      if (c.err) errs.push(c.err); else conds.push(c);
    }
    if (selector) {
      const c = test_selector(page, selector, until);
      if (c.err) errs.push(c.err); else conds.push(c);
    }
    if (text) {
      const c = test_text(page, text, until);
      if (c.err) errs.push(c.err); else conds.push(c);
    }
    if (network_quiet_ms) {
      const c = test_network(page, network_quiet_ms);
      if (c.err) errs.push(c.err); else conds.push(c);
    }
    if (errs.length) return `⚠️ ${errs.join('; ')}`;
    if (!conds.length) {
      return '⚠️ no condition given — pass at least one of url, selector, text, network_quiet_ms';
    }
    if (conds.length > MAX_CONDITIONS) {
      return `⚠️ too many conditions (${conds.length}) — at most ${MAX_CONDITIONS}`;
    }

    logger.info({ chatId, n: conds.length, timeout }, 'browser_wait');
    const r = await waitForConditions(page, conds, timeout);
    if (!r.met) return `⏳ ${r.detail}`;

    const title = await page.title().catch(() => '');
    const preview = tidy(await page.innerText('body').catch(() => '')).slice(0, 300);
    return `✅ ${r.detail} — now "${title}" (${page.url()})\n${preview}`;
  },
};
