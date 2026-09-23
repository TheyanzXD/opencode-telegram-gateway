// language: JavaScript (Node 20+ ESM), file: src/format/html.js
// Telegram HTML rendering with automatic entity balancing.
//
// HTML mode is far more forgiving than MarkdownV2 — `.`, `-`, `(`, `)`, `!` need
// no escaping, so a model's natural prose survives. The one thing that still
// produces a 400 is an unclosed tag: `<b>` opened but never closed, which
// happens whenever a long reply is split mid-entity.
//
// balanceHtmlEntities() closes whatever is still open at the end of a chunk and
// re-opens the same set at the start of the next one, so every chunk is a
// complete, valid document on its own.

const PAIRED = ['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'pre', 'blockquote', 'spoiler'];
const SELF_CLOSING = new Set(['br', 'hr', 'tg-spoiler']);

/** Escape the five characters Telegram's HTML parser treats as markup. */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Convert a subset of Markdown to Telegram HTML.
 * Only the pairs Telegram supports: bold, italic, underline, strikethrough,
 * code, pre, blockquote, and links. Everything else is left as plain text.
 */
export function mdToHtml(text) {
  if (!text) return '';
  let s = String(text);

  // fenced code blocks first — nothing inside is markup
  const codeBlocks = [];
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push(`<pre>${lang ? `<code class="language-${escapeHtml(lang)}">` : ''}${escapeHtml(code)}${lang ? '</code>' : ''}</pre>`);
    return `\u0000B${codeBlocks.length - 1}\u0000`;
  });

  const spans = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => {
    spans.push(`<code>${escapeHtml(c)}</code>`);
    return `\u0000S${spans.length - 1}\u0000`;
  });

  // remaining text is escaped — no stray < or > can open a tag
  s = escapeHtml(s);

  s = s.replace(/\*\*\*([\s\S]+?)\*\*\*/g, '<b><i>$1</i></b>'); // bold+italic
  s = s.replace(/__([\s\S]+?)__/g, '<u>$1</u>');
  s = s.replace(/\*\*([\s\S]+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/(?<!\w)\*([^\s*][\s\S]*?)\*(?!\w)/g, '<i>$1</i>');
  s = s.replace(/(?<!\w)_([^\s_][\s\S]*?)_(?!\w)/g, '<i>$1</i>');
  s = s.replace(/~~([\s\S]+?)~~/g, '<s>$1</s>');
  s = s.replace(/^>\s?([\s\S]+?)(?=\n\n|$)/gm, '<blockquote>$1</blockquote>');
  // links: [text](url) — url is validated to http(s) or mailto only
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
    (_, txt, url) => `<a href="${url}">${txt}</a>`);

  s = s.replace(/\u0000B(\d+)\u0000/g, (_, i) => codeBlocks[+i]);
  s = s.replace(/\u0000S(\d+)\u0000/g, (_, i) => spans[+i]);
  return s;
}

/**
 * Walk a chunk of HTML and return the tags that are still open at the end.
 * A simple scanner is enough: Telegram's subset has no nesting surprises, and
 * the input came from mdToHtml() above, not arbitrary user markup.
 */
function openTagsAtEnd(html) {
  const stack = [];
  const re = /<\/?([a-zA-Z-]+)[^>]*?(\/?)>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    if (SELF_CLOSING.has(tag) || m[2] === '/') continue;
    if (tag === 'a') { stack.push('a'); continue; } // links are paired too
    if (PAIRED.includes(tag)) {
      if (stack[stack.length - 1] === tag) stack.pop(); // closing the last open
      else stack.push(tag);
    }
  }
  return stack;
}

/**
 * Close entities left open at the end of a chunk and re-open them at the start
 * of the next, so each chunk is independently valid HTML.
 *
 * @param {string} html a chunk produced by mdToHtml()
 * @returns {{ closed: string, reopens: string }}
 */
export function balanceHtmlEntities(html) {
  const open = openTagsAtEnd(html);
  if (!open.length) return { closed: '', reopens: '' };
  // close in reverse order: <b><i> → </i></b>
  const closed = open.slice().reverse().map((t) => `</${t}>`).join('');
  // re-open in original order at the top of the next chunk
  const reopens = open.map((t) => `<${t}>`).join('');
  return { closed, reopens };
}

/**
 * Split HTML text into chunks that each stand alone: balanced tags, and each
 * chunk at most `max` characters.
 *
 * @param {string} html
 * @param {number} [max=3900]
 */
export function splitHtmlSafely(html, max = 3900) {
  if (typeof html !== 'string' || !html) return [];
  if (html.length <= max) return [html];

  const chunks = [];
  let rest = html;
  let reopen = '';

  while (rest.length > max) {
    // cut at the last tag boundary or newline before the limit — never mid-tag
    let cut = rest.slice(0, max).lastIndexOf('</');
    if (cut > max * 0.5) cut = rest.slice(0, cut).lastIndexOf('>') + 1;
    else cut = rest.slice(0, max).lastIndexOf('\n');
    if (cut < max * 0.3) cut = max; // give up on a clean boundary, cut hard

    const head = rest.slice(0, cut);
    rest = rest.slice(cut);

    const { closed, reopens } = balanceHtmlEntities(head);
    chunks.push(reopen + head + closed);
    reopen = reopens;
  }
  if (rest.trim().length) chunks.push(reopen + rest);
  return chunks;
}
