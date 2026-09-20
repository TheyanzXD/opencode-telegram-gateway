// language: JavaScript (Node 20+ ESM), file: src/agent/tools/browser-extract.js
// browser_extract — pull structured data out of a page the snapshot can't see.
//
// browser_read returns prose. A price table, a repo list, an inventory grid are
// not prose: they are rows of cells, and flattening them into text loses the
// column each number belongs to. The model then re-pairs them from context,
// which is where "the cheapest one" answers get the wrong column.
//
// This tool reads the page's own structure — tables, lists, definition lists,
// or a CSS selector the model supplies — and returns rows as JSON. When the
// site has no table markup at all and renders from JSON in a script tag, it can
// go straight to the source: the same shape the page rendered from, with no
// DOM round trip.
//
// Read-only. It parses what is already loaded; it never clicks, types, or
// navigates.

import { z } from 'zod';
import { logger } from '../../logger.js';
import { truncate, tidy, safeSelector } from './browser-refs.js';

const MAX_ROWS = 60;
const MAX_CELLS = 20;
const MAX_TEXT = 8000;

const extractSchema = z.object({
  selector: z.string().min(1).max(300).optional(),
  as: z.enum(['rows', 'list', 'links', 'json']).optional(),
  attribute: z.string().min(1).max(100).optional(),
  limit: z.number().int().positive().max(60).optional(),
});

/**
 * @param {object} args
 * @param {string} [args.selector]  a table/list selector; default: the first table on the page
 * @param {'rows'|'list'|'links'|'json'} [args.as]  output shape (default 'rows')
 * @param {string} [args.attribute]  with as:"json" or on elements: pull one attribute instead of text
 * @param {number} [args.limit]      cap on rows (default 60)
 */
export const browserExtract = {
  name: 'browser_extract',
  description:
    'Extract structured data from the current page as JSON rows: a table (default: the first <table> on the page, or pass a selector for a specific one), a list, all links, or JSON embedded in a <script> tag (as:"json" — looks for application/json, ld+json, or a JS object the page rendered from). as:"links" gives {text, url, rel} for every link in scope. Use this instead of browser_read when the data is tabular — it keeps columns aligned, which text flattening loses. Read-only.',
  isDangerous: false, // parsing only
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'Selector for the table, list, or container. Default: the first <table> on the page.' },
      as: { type: 'string', enum: ['rows', 'list', 'links', 'json'], description: 'Output shape: rows (table), list, links, or embedded JSON (default "rows")' },
      attribute: { type: 'string', description: 'With as:"json": the script id or type to read (e.g. "ld+json"). Otherwise: read this attribute instead of text from each matched element.' },
      limit: { type: 'number', description: 'Max rows/items to return (default 60)' },
    },
    // enum lists every shape the tool actually produces; "list-plain" is a
    // convenience the model may well guess, and accepting it costs one branch
    required: [],
    additionalProperties: false,
  },
  schema: extractSchema,
  async execute({ selector, as, attribute, limit }, ctx = {}) {
    const chatId = ctx.chatId ?? 0;
    const { getPage, sessionActive } = await import('../../browser/camoufox.js');
    if (!sessionActive(chatId)) {
      return '⚠️ embedded JSON extraction is unavailable without a browser session';
    }
    const page = await getPage(chatId);
    if (!page || page.isClosed?.()) return '⚠️ the browser page is closed — call browser_navigate first';

    const shape = as || 'rows';
    const cap = Math.min(limit || MAX_ROWS, MAX_ROWS);

    if (shape === 'json') {
      logger.info({ chatId }, 'browser_extract json');
      const r = await extractEmbeddedJson(page, selector, attribute);
      if (r.error) return `⚠️ ${r.error}`;
      return `✅ found ${r.count} JSON blob(s) — the shape the page rendered from:\n${truncate(JSON.stringify(r.data, null, 2), MAX_TEXT)}`;
    }

    if (shape === 'links') {
      const r = await extractLinks(page, selector, cap);
      if (r.error) return `⚠️ ${r.error}`;
      if (!r.links.length) return 'No links matched.';
      return `✅ ${r.links.length} link(s):\n${truncate(JSON.stringify(r.links, null, 1), MAX_TEXT)}`;
    }

    if (shape === 'list') {
      const r = await extractList(page, selector, cap, attribute);
      if (r.error) return `⚠️ ${r.error}`;
      if (!r.items.length) return 'No list items matched.';
      return `✅ ${r.items.length} item(s):\n${truncate(JSON.stringify(r.items, null, 1), MAX_TEXT)}`;
    }

    // ------------------------------------------------------------- rows
    const r = await extractTable(page, selector, cap);
    if (r.error) return `⚠️ ${r.error}`;
    if (!r.rows.length) return 'No rows matched.';
    return `✅ ${r.rows.length} row(s), ${r.headers.length} column(s) — ${r.headers.join(' | ')}:\n${truncate(JSON.stringify(r.rows, null, 1), MAX_TEXT)}`;
  },
};

// ----------------------------------------------------------------- tables

async function extractTable(page, selector, cap) {
  return page.evaluate(
    (sel, maxRows, maxCells) => {
      const table = sel ? document.querySelector(sel) : document.querySelector('table');
      if (!table) return { error: 'no <table> on this page — pass a selector for the container, or as:"list" / as:"links"' };

      // a <table> with no <tbody> still has rows; querySelectorAll covers both
      const headerCells = [...table.querySelectorAll('thead th, thead td')];
      let headers = headerCells.map((c) => (c.innerText || c.textContent || '').trim());
      const bodyRows = [...table.querySelectorAll('tbody tr, tr')];
      if (!headers.length && bodyRows.length) {
        // no <thead>: the first row is the header unless it has no cell text
        const first = [...bodyRows[0].querySelectorAll('th,td')];
        if (first.some((c) => (c.innerText || '').trim())) {
          headers = first.map((c) => (c.innerText || c.textContent || '').trim());
          bodyRows.shift();
        }
      }
      if (!bodyRows.length) return { error: 'that table has no rows' };

      const rows = [];
      for (const tr of bodyRows) {
        if (rows.length >= maxRows) break;
        const cells = [...tr.querySelectorAll('th,td')].slice(0, maxCells).map(
          (c) => (c.innerText || c.textContent || '').trim().replace(/\s+/g, ' ')
        );
        // a row that is all empty cells is a spacer, not data
        if (!cells.some((c) => c)) continue;
        rows.push(cells);
      }
      // unnamed columns get positional names so a row stays an object, not an array
      const keys = headers.length
        ? headers.map((h, i) => h || `col_${i + 1}`)
        : rows[0].map((_, i) => `col_${i + 1}`);
      const objects = rows.map((cells) => {
        const o = {};
        keys.forEach((k, i) => { o[k] = cells[i] ?? ''; });
        return o;
      });
      return { headers: keys, rows: objects };
    },
    selector || null,
    cap,
    MAX_CELLS
  );
}

// ------------------------------------------------------------------ lists

async function extractList(page, selector, cap, attribute) {
  return page.evaluate(
    (sel, maxRows, attr) => {
      // scope to a list the model named, else the first ul/ol/dl on the page
      const root = sel ? document.querySelector(sel) : document.querySelector('ul,ol,dl');
      if (!root) return { error: 'no list on this page — pass a selector for the container' };
      const items = [...root.querySelectorAll('li,dt,dd')].slice(0, maxRows).map((el) => {
        const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
        return { text, value: attr ? el.getAttribute(attr) || '' : '' };
      });
      return { items: items.filter((x) => x.text || x.value) };
    },
    selector || null,
    cap,
    attribute || null
  );
}

// ----------------------------------------------------------------- links

async function extractLinks(page, selector, cap) {
  return page.evaluate(
    (sel, maxRows) => {
      const root = sel ? document.querySelector(sel) : document.body;
      if (!root) return { error: 'selector matched nothing' };
      const seen = new Set();
      const links = [];
      for (const a of root.querySelectorAll('a[href]')) {
        if (links.length >= maxRows) break;
        const url = a.href; // resolved absolute URL — a.href, not getAttribute
        if (seen.has(url)) continue;
        seen.add(url);
        links.push({
          text: (a.innerText || a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
          url,
          rel: (a.rel || '').trim(),
        });
      }
      return { links };
    },
    selector || null,
    cap
  );
}

// -------------------------------------------------------- embedded json

/**
 * Sites ship the data they render from in a script tag more often than they
 * build it server-side. This finds application/json, ld+json, and JSON embedded
 * in an arbitrary script — the last one is a heuristic, and the parse is
 * best-effort: a script that is not JSON returns null and is skipped, not an
 * error.
 */
async function extractEmbeddedJson(page, selector, attribute) {
  return page.evaluate(
    (sel, attr) => {
      const want = attr || sel;
      const scripts = [...document.querySelectorAll('script')].filter((s) => {
        if (!want) return true;
        const t = (s.type || '').toLowerCase();
        return t.includes(String(want).toLowerCase()) || (s.id || '') === String(want);
      });
      const found = [];
      for (const s of scripts) {
        const type = (s.type || '').toLowerCase();
        if (type.includes('json')) {
          try { found.push(JSON.parse(s.textContent)); } catch {}
          continue;
        }
        // a script may contain an assignment — pull the JSON out of the right side
        const text = s.textContent || '';
        const m = /=\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*;?\s*$/m.exec(text);
        if (m) {
          try { found.push(JSON.parse(m[1])); } catch {}
        }
      }
      if (!found.length) return { error: 'no embedded JSON found — try a selector or attribute name (e.g. "ld+json")' };
      return { count: found.length, data: found.length === 1 ? found[0] : found };
    },
    selector || null,
    attribute || null
  );
}
