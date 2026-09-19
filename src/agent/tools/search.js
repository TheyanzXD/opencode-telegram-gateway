// language: JavaScript (Node 18+ ESM), file: src/agent/tools/search.js
// Tools: web_search (DuckDuckGo HTML — no key, no rate limit under personal use)
// and fetch_url (raw markdown-ish text). Not dangerous — read-only network.

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
      const results = [];
      const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      let m;
      while ((m = re.exec(html)) && results.length < n) {
        let link = m[1];
        // DDG redirects through a jump endpoint
        const jump = /uddg=([^&]+)/.exec(link);
        if (jump) link = decodeURIComponent(jump[1]);
        const title = m[2].replace(/<[^>]+>/g, '').trim();
        const snippet = m[3].replace(/<[^>]+>/g, '').trim();
        results.push(`${title}\n${link}\n${snippet}`);
      }
      return results.length ? results.join('\n\n') : `no results for "${query}"`;
    },
  },
  {
    name: 'fetch_url',
    description: 'Fetch a URL and return raw text/JSON (capped at 20 KB). Read-only.',
    isDangerous: false,
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: false,
    },
    schema: fetchSchema,
    async execute({ url }) {
      return fetchText(url, AbortSignal.timeout(25_000));
    },
  },
];
