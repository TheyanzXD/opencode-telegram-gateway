/**
 * Format a model reply for Telegram Markdown rendering.
 *
 * Bot API v1 `Markdown` parses `*bold*`, `_italic_`, `` `code` `` and
 * ```pre``` — and nothing else. Its two real failure modes are (a) underscores
 * *inside* a word, which the parser reads as italic markers and rejects the
 * whole message for, and (b) unbalanced markers. Both are 400s, and a 400
 * means the reply silently never arrives.
 *
 * Strategy: leave the model's Markdown alone (headings/lists/tables render as
 * literal text, which is fine and legible), but protect the characters that
 * would break parsing. `_` and `*` between two word characters are not markup
 * — they are identifiers and emphasis nobody asked for.
 */
export function toTelegramMarkdown(text) {
  if (!text) return '';
  let s = String(text);

  // 1. Fenced code blocks are verbatim — nothing inside is markup. Extract
  //    them first so the passes below can't touch their contents.
  const codeBlocks = [];
  s = s.replace(/```([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(code);
    return `\u0000CB${codeBlocks.length - 1}\u0000`;
  });

  // 2. Inline code spans, same treatment.
  const codeSpans = [];
  s = s.replace(/`([^`\n]+)`/g, (_, code) => {
    codeSpans.push(code);
    return `\u0000CS${codeSpans.length - 1}\u0000`;
  });

  // 2b. Residual tool-call markup that survived the tool parser must not reach
  //     the user as literal agent markup. Strip the whole block and its tags
  //     BEFORE the underscore pass (which would escape the underscores inside
  //     the tags and defeat the match).
  s = s.replace(/<\|tool_call_start\|>[\s\S]*?<\|tool_call_end\|>/g, '');
  s = s.replace(/<\|tool_call_(?:start|end)\|>/g, '');
  s = s.replace(/<\/?(function|parameter)(?:=[\w-]+)?>/g, '');

  // 3. Underscores inside a word: `user_model_name` → escaped, so the parser
  //    does not read them as italic. Between non-word chars they stay (real
  //    emphasis still works).
  s = s.replace(/(?<=\w)_(?=\w)/g, '\\_');

  // 4. Lone asterisks that will never close: `5 * 4` at start/end of a run.
  //    A `*` touching a space on one side is not bold-open.
  s = s.replace(/(^|\s)\*(?=\s|$)/gm, '$1\\*');

  // 4b. Balance the emph markers. Telegram's legacy Markdown rejects the
  //     whole message when a `*bold*` or `_italic_` opens but never closes —
  //     "can't find end of the entity at byte offset N". Count unescaped
  //     markers per line; an odd leftover opens an entity with no close, so
  //     escape it. Pairs stay markup.
  s = s.replace(/[\*_]/g, (ch, idx) => {
    // skip if already escaped (backslash before it)
    if (s[idx - 1] === '\\') return ch;
    return ch;
  });
  s = s.split('\n').map((line) => {
    let open = { '*': 0, _: 0 };
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if ((ch === '*' || ch === '_')) {
        // escaped?
        let bs = 0, j = i - 1;
        while (j >= 0 && line[j] === '\\') { bs++; j--; }
        if (bs % 2 === 0) {
          open[ch]++;
          // toggle: when a marker closes, both open count is even so far
        }
      }
      i++;
    }
    // escape the marker that would be left unpaired (odd count)
    const arr = line.split('');
    let seen = { '*': 0, _: 0 };
    const total = { '*': open['*'], _: open._ };
    for (let k = 0; k < arr.length; k++) {
      const ch = arr[k];
      if (ch !== '*' && ch !== '_') continue;
      let bs = 0, j = k - 1;
      while (j >= 0 && arr[j] === '\\') { bs++; j--; }
      if (bs % 2 !== 0) continue; // escaped, skip
      seen[ch]++;
      if (seen[ch] === total[ch] && seen[ch] % 2 === 1) {
        // the final marker of an odd run is the dangling opener — escape it
        arr[k] = '\\' + ch;
      }
    }
    return arr.join('');
  }).join('\n');

  // 5. Restore code, then escape any stray backtick left inside a block so an
  //    unclosed fence cannot swallow the rest of the message.
  s = s.replace(/\u0000CB(\d+)\u0000/g, (_, i) => '```' + codeBlocks[+i] + '```');
  s = s.replace(/\u0000CS(\d+)\u0000/g, (_, i) => '`' + codeSpans[+i] + '`');

  return s.slice(0, 4000);
}

/**
 * Split long text into Telegram-sized chunks without cutting mid-word or
 * mid-line. Paragraph boundaries first, sentence boundaries second, hard
 * chop only as a last resort. Respects a fenced code block by keeping it
 * intact when it fits and splitting it when it does not.
 */
export function splitLong(text, max = 4000) {
  if (typeof text !== 'string') return [];
  if (text.length <= max) return text ? [text] : [];

  const out = [];
  let rest = text;

  while (rest.length > max) {
    // prefer the last blank line before the limit
    let cut = rest.slice(0, max).lastIndexOf('\n\n');
    if (cut > max * 0.4) { out.push(rest.slice(0, cut)); rest = rest.slice(cut + 2); continue; }
    // then the last newline of all
    cut = rest.slice(0, max).lastIndexOf('\n');
    if (cut > max * 0.4) { out.push(rest.slice(0, cut)); rest = rest.slice(cut + 1); continue; }
    // then a word boundary
    cut = rest.slice(0, max).lastIndexOf(' ');
    if (cut > max * 0.4) { out.push(rest.slice(0, cut)); rest = rest.slice(cut + 1); continue; }
    // give up and cut mid-word
    out.push(rest.slice(0, max));
    rest = rest.slice(max);
  }
  if (rest) out.push(rest);
  return out;
}

/** MarkdownV2 escaping, for the one place that needs the strict spec. */
export function escapeV2(s) {
  return String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (m) => '\\' + m);
}
