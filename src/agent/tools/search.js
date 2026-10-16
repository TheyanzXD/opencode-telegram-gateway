// language: JavaScript (Node 18+ ESM), file: src/agent/tools/search.js
// Tools: web_search (DuckDuckGo HTML — no key, no rate limit under personal use)
// and fetch_url (raw text). Not dangerous — read-only network.
// HTML is parsed with cheerio, not regex: the previous regex walk broke the
// moment DDG changed a class name or an attribute order.

import { load } from 'cheerio';
import { z } from 'zod';
import { logger } from '../../logger.js';

const MAX_BODY = 20 * 1024; // 20 KB into context

const searchSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().positive().max(10).optional(),
});
const fetchSchema = z.object({
  url: z.string().url(),
});

async function fetchText(url, signal) {
  const res = await fetch(url, {
    signal,
    headers: {
      // some sites gate the default undici UA
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'text/html,application/json,text/plain,*/*',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    const j = await res.json();
    return JSON.stringify(j).slice(0, MAX_BODY);
  }
  const text = await res.text();
  return text.length > MAX_BODY ? text.slice(0, MAX_BODY) + '\n…[truncated]' : text;
}

import { browseWebsite } from '../web_browse.js';

const browseSchema = z.object({
  url: z.string().url(),
  extract_links: z.boolean().optional(),
  selector: z.string().optional(),
});

export const searchTools = [
  {
    name: 'web_search',
    description: 'Search the web. Returns title, URL, and a snippet for each result.',
    isDangerous: false,
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
      required: ['query'],
      additionalProperties: false,
    },
    schema: searchSchema,
    async execute({ query, limit }) {
      const n = limit ?? 5;
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      logger.info({ q: query.slice(0, 80) }, 'web_search');
      const html = await fetchText(url, AbortSignal.timeout(20_000));

      const $ = load(html);
      const results = [];
      $('a.result__a').each((_, el) => {
        if (results.length >= n) return false;
        const $el = $(el);
        let link = $el.attr('href') || '';
        // DDG redirects through a jump endpoint
        const jump = /uddg=([^&]+)/.exec(link);
        if (jump) link = decodeURIComponent(jump[1]);
        const title = $el.text().trim();
        const snippet = $el.closest('.result').find('.result__snippet').text().trim();
        results.push(`${title}\n${link}\n${snippet}`);
      });
      return results.length ? results.join('\n\n') : `no results for "${query}"`;
    },
  },
  {
    name: 'fetch_url',
    description: 'Fetch a URL and return clean Markdown or JSON (noise stripped). Read-only.',
    isDangerous: false,
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: false,
    },
    schema: fetchSchema,
    async execute({ url }) {
      const res = await browseWebsite({ url });
      return res.ok ? res.output : `error: ${res.error}`;
    },
  },
  {
    name: 'browse_website',
    description: 'Browse a website URL and extract readable Markdown content and optionally outbound links.',
    isDangerous: false,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        extract_links: { type: 'boolean' },
        selector: { type: 'string' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    schema: browseSchema,
    async execute({ url, extract_links, selector }) {
      const res = await browseWebsite({ url, extract_links, selector });
      return res.ok ? res.output : `error: ${res.error}`;
    },
  },
];
