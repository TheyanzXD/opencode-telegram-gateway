// language: JavaScript (Node 20+ ESM), file: tests/format-chunking.test.mjs
// Acceptance: a split must never leave an unclosed code fence — Telegram
// answers 400 for an unbalanced entity, and the bot drops the reply.

import test from 'node:test';
import assert from 'node:assert/strict';

import { splitMarkdownSafely, splitLong, toTelegramMarkdown } from '../src/format.js';
import { mdToHtml, balanceHtmlEntities, splitHtmlSafely } from '../src/format/html.js';

test('short text is returned as one chunk', () => {
  assert.deepEqual(splitMarkdownSafely('hello world'), ['hello world']);
});

test('a code block split in the middle is closed and reopened', () => {
  const lang = 'js';
  const head = 'const a = 1;\n';
  const block = '```' + lang + '\n' + 'x'.repeat(4200) + '\n```';
  const parts = splitMarkdownSafely(head + block);

  assert.ok(parts.length >= 2, 'was not split');
  assert.ok(parts[0].endsWith('```'), `first chunk does not close the fence: ...${parts[0].slice(-20)}`);
  const rest = parts.slice(1).join('\n');
  assert.ok(rest.startsWith('```' + lang), 'continuation chunk does not reopen the fence with its language');
  assert.ok(rest.endsWith('```'), 'final chunk does not close the fence');
});

test('the language tag survives a split', () => {
  const block = '```python\n' + 'y'.repeat(4200) + '\n```';
  const parts = splitMarkdownSafely(block);
  assert.ok(parts[1].startsWith('```python'), 'language lost across the split');
});

test('no chunk exceeds the limit', () => {
  const text = '# title\n\n' + 'word '.repeat(2000) + '\n\n```js\n' + 'z'.repeat(5000) + '\n```\n';
  for (const c of splitMarkdownSafely(text, 2000)) assert.ok(c.length <= 2000, `chunk ${c.length} > limit`);
});

test('code fences are balanced in every chunk', () => {
  const text = '```js\n' + 'a'.repeat(5000) + '\n```\npar\n```py\n' + 'b'.repeat(5000) + '\n```';
  for (const c of splitMarkdownSafely(text, 1500)) {
    const fences = c.match(/```/g);
    assert.ok(fences && fences.length % 2 === 0, `unbalanced fences in chunk: ${fences?.length}`);
  }
});

test('splitLong still works — it is the fallback path message.js uses', () => {
  const parts = splitLong('a'.repeat(5000), 2000);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((p) => p.length <= 2000));
});

test('toTelegramMarkdown escapes underscores inside words', () => {
  const out = toTelegramMarkdown('see my_var_name here');
  assert.ok(out.includes('my\\_var\\_name'), `underscore not escaped: ${out}`);
});

test('toTelegramMarkdown leaves code blocks untouched', () => {
  const out = toTelegramMarkdown('```\nmy_var = 1\n```');
  assert.ok(out.includes('my_var = 1'), 'code block content was escaped');
});

test('toTelegramMarkdown strips leftover tool tags', () => {
  const out = toTelegramMarkdown('hi <|tool_call_start|>{...}<|tool_call_end|> there');
  assert.ok(!out.includes('tool_call'), 'tool tags survived');
  assert.ok(out.includes('hi'));
});

// ---- HTML mode ----

test('balanceHtmlEntities closes an unclosed <b>', () => {
  const { closed, reopens } = balanceHtmlEntities('<b>bold and stopped mid-');
  assert.ok(closed.includes('</b>'), 'tag not closed');
  assert.ok(reopens.startsWith('<b>'), 'continuation does not reopen the tag');
});

test('balanceHtmlEntities leaves balanced markup alone', () => {
  const { closed, reopens } = balanceHtmlEntities('<b>ok</b>');
  assert.equal(closed, '');
  assert.equal(reopens, '');
});

test('mdToHtml escapes raw ampersands and unbalanced brackets', () => {
  const out = mdToHtml('a < b > c & d');
  assert.ok(out.includes('&lt;'), 'unbalanced < not escaped');
  assert.ok(out.includes('&amp;'), '& not escaped');
});

test('mdToHtml converts bold and italics', () => {
  const out = mdToHtml('**bold** and *italics*');
  assert.ok(out.includes('<b>bold</b>'), 'bold not converted');
  assert.ok(out.includes('<i>italics</i>'), 'italics not converted');
});

test('mdToHtml preserves code blocks (escaped for transport)', () => {
  const out = mdToHtml('```js\nif (a < b && c > d) {}\n```');
  assert.ok(/<pre>(<code[^>]*>)?/.test(out), 'code block not wrapped');
  // code IS escaped — that is correct: Telegram decodes the entities on render,
  // so the user sees `a < b && c > d`, and a raw `<` would open a real tag
  assert.ok(out.includes('if (a &lt; b &amp;&amp; c &gt; d)'), 'code content not escaped for transport');
});

test('splitHtmlSafely keeps tags balanced across chunks', () => {
  const html = mdToHtml('<b>' + 'x'.repeat(5000) + '</b>');
  const parts = splitHtmlSafely(html, 1000);
  assert.ok(parts.length >= 2);
  for (const p of parts) {
    const opens = (p.match(/<b>/g) || []).length;
    const closes = (p.match(/<\/b>/g) || []).length;
    assert.equal(opens, closes, `unbalanced <b> in a chunk: ${opens} vs ${closes}`);
  }
});
