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
 * A CSS selector safe to interpolate into page.evaluate: only ids, classes,
 * tag names, and attribute value pairs. Anything else (pseudo-classes, commas,
 * combinators — the things that make ":has(text/…)" an injection vector) is
 * rejected outright. Browser tools build selectors from page content, so a
 * hostile page is a real input.
 */
const SAFE_ID_OR_CLASS = /^[A-Za-z_][\w-]*$/;
const SAFE_ATTR_VALUE = /^[\w\s:/.-]+$/;

export function safeSelector(sel) {
  const s = String(sel || '').trim();
  if (!s) return { err: 'empty selector' };
  if (/[{}();>+~[\]"'\\]/.test(s)) return { err: `selector rejected (unsupported syntax): ${s}` };
  if (/:/.test(s) && !/^#[A-Za-z_][\w-]*$/.test(s)) {
    // allow #id only; a ":" anywhere else means pseudo-class or a text() trap
    return { err: `selector rejected (no pseudo-selectors allowed): ${s}` };
  }
  const parts = s.split(/\s+/).filter(Boolean);
  for (const p of parts) {
    if (/^#[A-Za-z_][\w-]*$/.test(p)) continue;
    if (/^\.[A-Za-z_][\w-]*$/.test(p)) continue;
    if (/^[A-Za-z][\w-]*$/.test(p)) continue;
    const attr = /^\[([A-Za-z_][\w-]*)=([^\]]+)\]$/.test(p) && RegExp.$1 && RegExp.$2;
    if (attr && SAFE_ID_OR_CLASS.test(attr[0]) && SAFE_ATTR_VALUE.test(attr[1])) continue;
    return { err: `selector rejected (unrecognized part): ${p}` };
  }
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
