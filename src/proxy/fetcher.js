import { fetch } from 'undici';
import { PROXY_SOURCES } from './sources.js';
import { upsertProxy, proxyStats, pruneProxies } from '../db.js';
import { logger } from '../logger.js';

const PARSE_REGEX = /^\s*(?:(\w+):\/\/)?([0-9]{1,3}(?:\.[0-9]{1,3}){3}|[0-9a-fA-F:]+):(\d{1,5})\s*$/;

export function parseLine(line, defaultScheme = 'http') {
  const m = PARSE_REGEX.exec(line);
  if (!m) return null;
  const scheme = (m[1] || '').toLowerCase();
  const host = m[2];
  const port = parseInt(m[3], 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
  if (!/^[0-9.]+$/.test(host) && !host.includes(':')) return null;
  // skip placeholder / loopback entries from sources
  if (host === '0.0.0.0' || host === '127.0.0.1' || host === '::' || host === '::1') return null;
  return { scheme: scheme || defaultScheme, host, port };
}

async function fetchSource(url, scheme) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      logger.warn({ url, status: res.status }, 'proxy source failed');
      return [];
    }
    const text = await res.text();
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      const p = parseLine(line, scheme);
      if (p) out.push({ ...p, source: url });
    }
    return out;
  } catch (err) {
    logger.warn({ url, err: err.message }, 'proxy source error');
    return [];
  }
}

export async function refresh({ perScheme = PROXY_SOURCES, parallel = 8, target = 10_000 } = {}) {
  const startedAt = Date.now();
  const urls = [];
  for (const [scheme, list] of Object.entries(perScheme)) {
    for (const u of list) urls.push({ url: u, scheme });
  }
  logger.info({ sources: urls.length }, 'proxy refresh start');

  let inserted = 0;
  let idx = 0;
  const seen = new Set();
  const before = proxyStats().total;

  // Work queue driven by N workers
  async function worker() {
    while (idx < urls.length) {
      const my = idx++;
      const { url, scheme } = urls[my];
      const items = await fetchSource(url, scheme);
      for (const p of items) {
        const key = `${p.scheme}://${p.host}:${p.port}`;
        if (seen.has(key)) continue;
        seen.add(key);
        upsertProxy(p);
        inserted++;
      }
      if (proxyStats().total >= target) break;
    }
  }
  const workers = Array.from({ length: parallel }, () => worker());
  await Promise.all(workers);

  const pruned = pruneProxies();
  const stats = proxyStats();
  logger.info({
    duration_ms: Date.now() - startedAt,
    inserted,
    before,
    total: stats.total,
    healthy: stats.healthy,
    pruned,
  }, 'proxy refresh done');
  return stats;
}
