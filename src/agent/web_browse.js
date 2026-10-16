// language: JavaScript (Node 20+ ESM), file: src/agent/web_browse.js
// Advanced Web Browsing engine for AI agents (Hermes-style).
// Fetches web pages, strips scripts/styles/noise, converts DOM to structured
// Markdown (headers, lists, tables, code blocks, links), and extracts outbound links.

import { load } from 'cheerio';
import { logger } from '../logger.js';

const DEFAULT_MAX_CHARS = 15_000;
const FETCH_TIMEOUT_MS = 25_000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Clean and convert Cheerio DOM element to structured Markdown.
 */
function domToMarkdown($, root) {
  // Strip non-content and noise elements
  root.find('script, style, noscript, iframe, svg, canvas, object, embed, [aria-hidden="true"]').remove();

  // Strip common banner/cookie/ad noise if targeting whole body
  root.find('nav, footer, aside, .cookie-banner, .cookie-consent, .modal, .ads, .ad, #cookie-banner, #cookie-notice').remove();

  // Convert tables to Markdown
  root.find('table').each((_, tableEl) => {
    const $table = $(tableEl);
    const rows = [];
    $table.find('tr').each((_, trEl) => {
      const cells = [];
      $(trEl).find('th, td').each((_, cellEl) => {
        const txt = $(cellEl).text().trim().replace(/[\r\n\t]+/g, ' ').replace(/\|/g, '\\|');
        cells.push(txt);
      });
      if (cells.length > 0) rows.push(cells);
    });

    if (rows.length === 0) return;

    // Pad rows so every row has the same number of columns
    const maxCols = Math.max(...rows.map((r) => r.length));
    const normalizedRows = rows.map((r) => {
      while (r.length < maxCols) r.push('');
      return r;
    });

    const header = normalizedRows[0];
    const separator = header.map(() => '---');
    const bodyRows = normalizedRows.slice(1);

    const mdTable = [
      `| ${header.join(' | ')} |`,
      `| ${separator.join(' | ')} |`,
      ...bodyRows.map((r) => `| ${r.join(' | ')} |`),
    ].join('\n');

    $table.replaceWith(`\n\n${mdTable}\n\n`);
  });

  // Convert pre/code blocks
  root.find('pre').each((_, preEl) => {
    const $pre = $(preEl);
    const code = $pre.text();
    const lang = $pre.find('code').attr('class')?.replace(/^language-/, '') || '';
    $pre.replaceWith(`\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`);
  });

  // Convert headings
  root.find('h1, h2, h3, h4, h5, h6').each((_, hEl) => {
    const $h = $(hEl);
    const level = parseInt(hEl.tagName.substring(1), 10) || 1;
    const prefix = '#'.repeat(level);
    const text = $h.text().trim().replace(/\s+/g, ' ');
    $h.replaceWith(`\n\n${prefix} ${text}\n\n`);
  });

  // Convert blockquotes
  root.find('blockquote').each((_, bqEl) => {
    const $bq = $(bqEl);
    const lines = $bq.text().trim().split('\n').map((l) => `> ${l.trim()}`).join('\n');
    $bq.replaceWith(`\n\n${lines}\n\n`);
  });

  // Convert list items
  root.find('li').each((_, liEl) => {
    const $li = $(liEl);
    const text = $li.text().trim().replace(/\s+/g, ' ');
    $li.replaceWith(`\n- ${text}`);
  });

  // Convert paragraphs and divs
  root.find('p').each((_, pEl) => {
    const $p = $(pEl);
    const text = $p.text().trim().replace(/\s+/g, ' ');
    if (text) $p.replaceWith(`\n\n${text}\n\n`);
    else $p.remove();
  });

  // Convert inline links to markdown [text](href)
  root.find('a').each((_, aEl) => {
    const $a = $(aEl);
    const text = $a.text().trim().replace(/\s+/g, ' ');
    const href = $a.attr('href');
    if (text && href && !href.startsWith('#') && !href.startsWith('javascript:')) {
      $a.replaceWith(`[${text}](${href})`);
    } else if (text) {
      $a.replaceWith(text);
    }
  });

  const rawText = root.text();
  // Normalize whitespace: collapse multiple blank lines to two
  return rawText
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Fetch and extract page content into clean Markdown.
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {boolean} [opts.extract_links]
 * @param {string} [opts.selector]
 * @param {number} [opts.max_chars]
 * @returns {Promise<{ok: boolean, output?: string, title?: string, url?: string, error?: string, links?: Array<{text: string, url: string}>}>}
 */
export async function browseWebsite({ url, extract_links = false, selector, max_chars = DEFAULT_MAX_CHARS }) {
  let targetUrl;
  try {
    targetUrl = new URL(url);
    if (!/^https?:$/.test(targetUrl.protocol)) {
      return { ok: false, error: 'Only HTTP and HTTPS URLs are supported' };
    }
  } catch (err) {
    return { ok: false, error: `Invalid URL: ${err.message}` };
  }

  logger.info({ url: targetUrl.href }, 'browseWebsite: fetching');

  try {
    const res = await fetch(targetUrl.href, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,text/plain,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
      },
    });

    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} ${res.statusText} when fetching ${targetUrl.href}` };
    }

    const contentType = res.headers.get('content-type') || '';

    // Handle JSON endpoints directly
    if (contentType.includes('application/json')) {
      const data = await res.json();
      const formatted = JSON.stringify(data, null, 2);
      const out = formatted.length > max_chars
        ? formatted.slice(0, max_chars) + `\n…(truncated JSON, ${formatted.length - max_chars} more chars)`
        : formatted;
      return { ok: true, output: out, url: res.url, contentType: 'json' };
    }

    // Handle plain text directly
    if (contentType.includes('text/plain') || contentType.includes('text/markdown')) {
      const text = await res.text();
      const out = text.length > max_chars
        ? text.slice(0, max_chars) + `\n…(truncated text, ${text.length - max_chars} more chars)`
        : text;
      return { ok: true, output: out, url: res.url, contentType: 'text' };
    }

    // Parse HTML
    const html = await res.text();
    const $ = load(html);

    const title = $('title').text().trim() || $('meta[property="og:title"]').attr('content') || '';
    const description = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';

    // Collect outbound links if requested
    const links = [];
    if (extract_links) {
      const seen = new Set();
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        const text = $(el).text().trim().replace(/\s+/g, ' ');
        if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) return;
        try {
          const abs = new URL(href, res.url).href;
          if (!seen.has(abs) && text.length > 0) {
            seen.add(abs);
            links.push({ text: text.slice(0, 80), url: abs });
          }
        } catch {}
      });
    }

    // Target specific element if selector provided, else main/article/body
    let root;
    if (selector) {
      root = $(selector);
      if (!root.length) {
        return { ok: false, error: `Selector "${selector}" not found on page. Available tags: article, main, body` };
      }
    } else {
      root = $('article').length ? $('article') : ($('main').length ? $('main') : $('body'));
    }

    let markdown = domToMarkdown($, root);

    // Build header info
    const headerLines = [];
    if (title) headerLines.push(`# ${title}`);
    if (description) headerLines.push(`> ${description}`);
    headerLines.push(`URL: ${res.url}`);

    let fullOutput = `${headerLines.join('\n\n')}\n\n---\n\n${markdown}`;

    // Append extracted links summary if requested
    if (extract_links && links.length > 0) {
      const topLinks = links.slice(0, 40).map((l, i) => `${i + 1}. [${l.text}](${l.url})`).join('\n');
      fullOutput += `\n\n### Discovered Links (${links.length} total):\n${topLinks}`;
    }

    if (fullOutput.length > max_chars) {
      fullOutput = fullOutput.slice(0, max_chars) + `\n\n…(truncated, ${fullOutput.length - max_chars} more chars. Use selector or increase max_chars)`;
    }

    return {
      ok: true,
      output: fullOutput,
      title,
      url: res.url,
      linksCount: links.length,
      links: extract_links ? links.slice(0, 40) : undefined,
    };
  } catch (err) {
    logger.warn({ err: err.message, url: targetUrl.href }, 'browseWebsite failed');
    return { ok: false, error: `Failed to browse ${targetUrl.href}: ${err.message}` };
  }
}
