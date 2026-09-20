// language: JavaScript (Node 20+ ESM), file: src/agent/tools/browser-refs.js
// Shared internals for the advanced browser tools.
//
// The base tool set (browser.js) keeps its own @eN map because its snapshot is
// a flat list of clickable nodes. The advanced tools need more: keyboard focus,
// scroll position, frames, option lists, window handles — none of which fit in
// one array of anchors. This module keeps those maps side by side in one record
// per chat, so a browser_scroll can hand the model a fresh @eN list it produced
// itself and a browser_click on that same ref resolves through the same lookup.
//
// Maps are keyed by chatId, exactly like camoufox.js's session map. Two
// concurrent chats never share refs.

import { getPage, sessionActive } from '../../browser/camoufox.js';

/** chatId → {focus, scroll, select, handles} */
const _maps = new Map();

function mapOf(chatId) {
  if (!_maps.has(chatId)) {
    _maps.set(chatId, { focus: [], scroll: [], select: [], handles: [] });
  }
  return _maps.get(chatId);
}

export function clearAdvancedRefs(chatId) {
  _maps.delete(chatId);
}

/**
 * Resolve "@fN" / "@sN" / "@oN" / "@wN" against the right per-chat map.
 * Anything that does not match a known prefix is returned untouched as a
 * selector — same convention as browser.js, so the model can still pass a raw
 * Playwright selector when a ref does not exist for what it wants.
 *
 * @returns {{sel: string|null, err?: string}}
 */
export function resolveAdvancedRef(chatId, kind, target) {
  if (typeof target !== 'string' || !target) return { sel: null, err: 'target must be a non-empty string' };
  const m = /^@([fso])(\d+)$/.exec(target.trim());
  if (!m) return { sel: target };
  const prefix = m[1];
  const key = prefix === 'f' ? 'focus' : prefix === 's' ? 'scroll' : 'select';
  const arr = mapOf(chatId)[key];
  const el = arr[Number(m[2])];
  if (!el) return { sel: null, err: `stale ref ${target} — the map it came from has been rebuilt` };
  return { sel: el.sel };
}

/** Store a list and hand back labels the model can quote. */
export function setRefList(chatId, key, list) {
  const prefix = key === 'focus' ? 'f' : key === 'scroll' ? 's' : key === 'select' ? 'o' : null;
  if (!prefix) throw new Error(`unknown ref kind: ${key}`);
  const arr = (list || []).filter((x) => x && typeof x.sel === 'string');
  mapOf(chatId)[key] = arr;
  return arr.map((e, i) => ({ ...e, ref: `@${prefix}${i}` }));
}

export function getRefList(chatId, key) {
  return mapOf(chatId)[key];
}

/** Window-handle list is not selector-shaped; keep it raw. */
export function setHandles(chatId, handles) {
  mapOf(chatId).handles = handles || [];
}
export function getHandles(chatId) {
  return mapOf(chatId).handles;
}

/**
 * A CSS selector safe to interpolate into page.evaluate: simple selectors
 * (#id, .class, tag, [attr=value]) joined by combinators and commas. Rejected
 * outright: pseudo-classes and Playwright's text engines (`:has-text(…)`,
 * `:text(…)`), which are the injection vectors — a hostile page's own text is
 * the input these selectors are built from. Quotes are allowed only inside an
 * attribute bracket, and every bracket must be balanced.
 *
 * @returns {{sel: string} | {err: string}}
 */
const SIMPLE = {
  id: /^#[A-Za-z_][\w-]*$/,
  cls: /^\.[A-Za-z_][\w-]*$/,
  tag: /^[A-Za-z][\w-]*$/,
  // an unquoted attribute value is fine when it is a plain identifier or
  // number ([type=text]); anything looser is an injection surface
  attr: /^\[[A-Za-z_][\w-]*(?:[~|^$*]?=(?:"[^"\\\n]*"|'[^'\\\n]*'|[\w.-]+))?\]$/,
};

export function safeSelector(sel) {
  const s = String(sel || '').trim();
  if (!s) return { err: 'empty selector' };
  if (/[{}();]/.test(s)) return { err: `selector rejected (unsupported syntax): ${s}` };
  if (/\\/.test(s)) return { err: `selector rejected (escapes are not allowed): ${s}` };

  // Tokenize in one pass: attribute selectors, combinators (whitespace runs
  // become the descendant combinator ' '), and the simple selectors between
  // them — including compound selectors, whose parts sit directly adjacent
  // (`input[type=text]`, `div.foo`) with no combinator token between them.
  const parts = [];
  let last = 0;
  for (const m of s.matchAll(/(\[[^\]]*\]|\s+|[,>+~])/g)) {
    if (m.index > last) parts.push(s.slice(last, m.index).trim());
    parts.push(m[0].trim() || ' ');
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push(s.slice(last).trim());

  // validate each token. Consecutive simple selectors with no combinator
  // between them are a compound selector (`input[type=text]`, `div.foo`) —
  // legal CSS, so nothing is required between them. A combinator between two
  // simple selectors is also legal. What is not: starting or ending with one.
  // Syntactic perfection is Playwright's problem; this check exists to keep
  // pseudo-selectors and text engines out, not to parse CSS.
  //
  // Pseudo-checks run per-token over the characters an attribute selector does
  // not own. A compound token (`div.foo`) is split into its simple parts first;
  // an attribute bracket is kept whole because its value may legitimately
  // contain a colon or a quote.
  const COMBINATOR = new Set([',', '>', '+', '~', ' ']);
  const isAttr = (p) => p.startsWith('[');
  const subTokens = (p) => (isAttr(p)
    ? [p]
    : p.split(/(\[[^\]]*\])/).filter(Boolean));

  let sawSelector = false;
  let trailingCombinator = false;
  for (const p of parts) {
    if (!p) continue;
    if (COMBINATOR.has(p)) {
      if (!sawSelector) return { err: `selector rejected (stray combinator): ${s}` };
      trailingCombinator = true;
      continue;
    }
    for (const sub of subTokens(p)) {
      if (isAttr(sub)) continue; // its contents were checked by the regex below
      if (sub.includes(':')) return { err: `selector rejected (no pseudo-selectors): ${s}` };
      if (sub.includes('"') || sub.includes("'")) {
        return { err: `selector rejected (quotes belong in an attribute selector): ${s}` };
      }
    }
    // every simple part of the token must be an id, class, tag, or attribute
    const okOne = /^((?:#[A-Za-z_][\w-]*|\.[A-Za-z_][\w-]*|[A-Za-z][\w-]*|\[[^\]]*\]))+$/u.test(p);
    if (!okOne) return { err: `selector rejected (unrecognized part "${p}"): ${s}` };
    sawSelector = true;
    trailingCombinator = false;
  }
  if (!sawSelector) return { err: `selector rejected (no selector in "${s}")` };
  if (trailingCombinator) return { err: `selector rejected (ends with a combinator): ${s}` };
  return { sel: s };
}

/**
 * One guard for every tool that mutates the page. Returns an error string when
 * the session is gone or the target cannot be used, so the tool answers with a
 * ⚠️ instead of throwing into the registry.
 *
 * @returns {Promise<{page: object, sel: string} | {err: string}>}
 */
export async function resolvePageAndTarget(chatId, kind, target) {
  if (!sessionActive(chatId)) {
    return { err: 'no browser session for this chat — call browser_navigate first' };
  }
  const page = await getPage(chatId);
  if (!page || page.isClosed?.()) return { err: 'the browser page is closed — call browser_navigate first' };
  if (!target) return { err: 'a target is required' };
  const r = resolveAdvancedRef(chatId, kind, target);
  if (r.err) return { err: r.err };
  if (!r.sel) return { err: `could not resolve target: ${target}` };
  return { page, sel: r.sel };
}

/** Truncate a string for the tool result, marking the cut. */
export function truncate(text, cap) {
  const s = String(text ?? '');
  return s.length > cap ? `${s.slice(0, cap)}\n\n…[truncated, ${s.length - cap} more chars]` : s;
}

/** Collapse whitespace the way the read-only tools do. */
export function tidy(text) {
  return String(text ?? '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
