import { fetch } from 'undici';
import { logger } from '../logger.js';

// DuckDuckGo HTML scrape (no API key). Cached 1h.
// ponytail: proper SERP (Brave/Tavily) when budgets allow.

const cache = new Map(); // query -> { ts, results }
const TTL_MS = 60 * 60 * 1000;

export async function webSearch(query, k = 5) {
  if (!query || !query.trim()) return [];
  const cached = cache.get(query);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.results;

  let results = [];
  try {
    results = await duckduckgo(query, k);
  } catch (err) {
    logger.warn({ err: err.message }, 'web_search: DDG failed, trying instant answer');
    try { results = await instantAnswer(query, k); }
    catch (err2) {
      logger.warn({ err: err2.message }, 'web_search: instant answer failed');
      results = [];
    }
  }
  cache.set(query, { ts: Date.now(), results });
  return results;
}

async function duckduckgo(query, k) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (opencode-telegram-gateway)',
      'Accept': 'text/html',
    },
  });
  if (!res.ok) throw new Error(`DDG HTTP ${res.status}`);
  const html = await res.text();
  return parseDDG(html, k);
}

function parseDDG(html, k) {
  const results = [];
  const titleRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const titles = [];
  let m;
  while ((m = titleRe.exec(html)) && titles.length < k) {
    titles.push({ url: m[1], title: stripHtml(m[2]) });
  }
  const snippets = [];
  while ((m = snippetRe.exec(html)) && snippets.length < k) {
    snippets.push(stripHtml(m[1]));
  }
  for (let i = 0; i < titles.length; i++) {
    results.push({
      title: titles[i].title,
      url: titles[i].url,
      snippet: snippets[i] || '',
    });
  }
  return results;
}

async function instantAnswer(query, k) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;
  const res = await fetch(url, { headers: { 'User-Agent': 'opencode-telegram-gateway' } });
  if (!res.ok) throw new Error(`DDG IA HTTP ${res.status}`);
  const data = await res.json();
  const out = [];
  if (data.AbstractText) out.push({ title: data.Heading || query, url: data.AbstractURL || '', snippet: data.AbstractText });
  if (Array.isArray(data.RelatedTopics)) {
    for (const t of data.RelatedTopics.slice(0, k)) {
      if (t.Text) out.push({ title: t.Text.split(' - ')[0] || '', url: t.FirstURL || '', snippet: t.Text });
    }
  }
  return out.slice(0, k);
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, '').replace(/&[a-z]+;/g, ' ').trim().slice(0, 400);
}