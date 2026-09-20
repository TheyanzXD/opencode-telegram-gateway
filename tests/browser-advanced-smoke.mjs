// language: JavaScript (Node 20+ ESM), file: tests/browser-advanced-smoke.mjs
// Smoke test for the advanced browser tools: runs every tool against a fake
// Playwright page, so the code paths that need a browser are exercised without
// launching Camoufox. Not part of `npm test` (that suite needs a real browser).
//
// The tools import camoufox.js directly, and ESM exports are read-only, so the
// fake page is injected through Node's loader instead: the hook below points
// every import of src/browser/camoufox.js at a stub in this directory.
//
//   node tests/browser-advanced-smoke.mjs

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// The tools import src/browser/camoufox.js directly, and ESM exports are
// read-only, so the fake page is injected through a loader instead: the hook
// in camoufox-stub.mjs rewrites that one import to point at the stub. Both
// arguments are real file URLs — import.meta.url already is one, and a bare
// './x' here would resolve against the cwd rather than this file.
register(
  new URL('./camoufox-stub.mjs', import.meta.url).href,
  import.meta.url
);

// register() must run before the tool modules load, or they bind the real
// camoufox.js first. A top-level await on the registry here would still work,
// but the dynamic imports below keep that ordering visible at the call site.
const cid = 424242;
const { createDefaultRegistry } = await import('../src/agent/registry.js');
const { setFakePage } = await import('./camoufox-stub.mjs');
const {
  clearAdvancedRefs,
  safeSelector,
  resolveAdvancedRef,
  setRefList,
} = await import('../src/agent/tools/browser-refs.js');

// ------------------------------------------------------------- fake page
const FAKE_PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); // signature only

class FakePage {
  constructor() {
    this.scrollY = 0;
    this.filled = [];
    this.checked = new Set();
    this.pressed = null;
    this.listeners = {};
  }
  async goto(url) { this.url_ = url; }
  url() { return this.url_ || 'https://example.test/page'; }
  async title() { return 'Example Page'; }
  isClosed() { return false; }
  async waitForTimeout() {}
  async innerText(sel) { return sel === 'body' ? 'Example page text' : 'text of ' + sel; }
  async evaluate(fn, ...args) {
    const src = String(fn);
    if (src.includes('window.scrollY')) return { x: 0, y: this.scrollY, vh: 800, docH: 4000 };
    if (src.includes('window.scrollBy')) { this.scrollY += args[0] || 0; return null; }
    if (src.includes('window.innerHeight')) return 800;
    if (src.includes('document.activeElement')) {
      return this.focusedSel ? [{ tag: 'input', name: 'q', value: 'hello', sel: '#q' }] : [];
    }
    if (src.includes('createTreeWalker')) {
      return [
        { level: 1, name: 'Heading one', y: 100, sel: '#h1' },
        { level: 2, name: 'Section two', y: 900, sel: '#s2' },
      ];
    }
    if (src.includes('querySelectorAll("script")')) return { count: 1, data: { sku: 'ABC' } };
    if (src.includes('a[href]')) return { links: [{ text: 'Home', url: 'https://example.test/' }] };
    if (src.includes('li,dt,dd')) return { items: [{ text: 'one' }, { text: 'two' }] };
    if (src.includes('thead th')) {
      return { headers: ['name', 'price'], rows: [{ name: 'w', price: '9' }] };
    }
    if (src.includes('input,textarea,select')) {
      return {
        fields: [
          { key: 'q', tag: 'input', type: 'text', label: 'Search', required: true,
            disabled: false, readonly: false, value: '', placeholder: 'Search', sel: '#q' },
          { key: 'agree', tag: 'input', type: 'checkbox', label: 'I agree', required: false,
            disabled: false, readonly: false, value: 'on', placeholder: '', sel: '#agree',
            checked: false },
        ],
      };
    }
    // browser_console's bare-expression evaluate
    return { evaluated: args.length === 0 ? fn : null };
  }
  on(evt, fn) { this.listeners[evt] = fn; }
  off() {}
  locator(sel) {
    const self = this;
    return {
      first() { return this; },
      async click() { self.clicked = sel; },
      async fill(v) { self.filled.push([sel, v]); },
      async focus() { self.focusedSel = sel; },
      async isChecked() { return self.checked.has(sel); },
      async setChecked(v) { v ? self.checked.add(sel) : self.checked.delete(sel); },
      async selectOption(v) { self.filled.push([sel, v]); },
      async scrollIntoViewIfNeeded() { self.scrollY = 500; },
      async screenshot() { return FAKE_PNG; },
      async count() { return sel === '#missing' ? 0 : 1; },
    };
  }
  keyboard = { async press(k) { this.pressed = k; } };
  viewportSize() { return { width: 1280, height: 800 }; }
  setViewportSize() {}
  context() { return { pages: () => [this] }; }
  frames() { return []; }
}

setFakePage(new FakePage());
clearAdvancedRefs(cid);

const reg = createDefaultRegistry();
let pass = 0, fail = 0;

async function run(name, args, expect) {
  const out = await reg.execute(name, args, { chatId: cid });
  const text = String(typeof out.content === 'string' ? out.content : JSON.stringify(out.content));
  const ok = expect instanceof RegExp
    ? expect.test(text)
    : (Array.isArray(expect) ? expect.every((e) => text.includes(e)) : text.includes(expect));
  if (ok) { pass++; console.log(`PASS  ${name} ${JSON.stringify(args)}`); }
  else { fail++; console.log(`FAIL  ${name} ${JSON.stringify(args)}\n       got: ${text.slice(0, 240)}`); }
  return text;
}

console.log('--- advanced browser tools smoke test ---');

await run('browser_wait', { selector: 'main' }, '✅');
await run('browser_wait', { url: '/page' }, '✅');
await run('browser_wait', { text: 'Example' }, '✅');
await run('browser_wait', {}, '⚠️ no condition given');
await run('browser_wait', { selector: '#missing', timeout_ms: 400 }, '⏳');

await run('browser_scroll', { direction: 'down', amount_px: 500 }, ['✅ scrolled down 500 px', 'Landmarks:']);
await run('browser_scroll', { pages: 2 }, '✅');
await run('browser_scroll', { to: '#h1' }, '✅');
await run('browser_scroll', { direction: 'up' }, '✅ scrolled up');

await run('browser_keyboard', { keys: 'Enter' }, '✅ pressed Enter');
await run('browser_keyboard', { keys: 'Control+v' }, '✅ pressed Control+v');
await run('browser_keyboard', { keys: 'Tab', count: 2 }, '✅ pressed Tab ×2');
await run('browser_keyboard', { keys: 'NotAKey' }, '⚠️ unknown key');
await run('browser_keyboard', { keys: 'Shift' }, '⚠️ a key chord needs');

await run('browser_form', { read: true }, '@f0');
await run('browser_form', { values: { q: 'shoes', agree: true } }, '✅ q:');
await run('browser_form', { values: { nope: 'x' } }, '⚠️ no field matches');

await run('browser_extract', { as: 'rows' }, 'row(s)');
await run('browser_extract', { as: 'list' }, 'item(s)');
await run('browser_extract', { as: 'links' }, 'link(s)');
await run('browser_extract', { as: 'json' }, 'JSON');

await run('browser_console', { level: 'error' }, /console messages|No .*console/);
await run('browser_console', { evaluate: '1+1' }, '✅');

await run('browser_screenshot', { as: 'ansi' }, '⚠️ could not decode'); // fake PNG
await run('browser_screenshot', { as: 'png' }, '⚠️'); // decode guard trips first
await run('browser_tabs', { action: 'frames' }, 'no iframes');

// ref plumbing: a list one call stores resolves in the next
setRefList(cid, 'focus', [{ sel: '#q' }]);
const ok1 = resolveAdvancedRef(cid, 'focus', '@f0').sel === '#q';
console.log(`${ok1 ? 'PASS' : 'FAIL'}  resolveAdvancedRef @f0 → ${resolveAdvancedRef(cid, 'focus', '@f0').sel}`);
ok1 ? pass++ : fail++;

const stale = resolveAdvancedRef(cid, 'focus', '@f99');
const ok2 = /stale ref/.test(stale.err || '');
console.log(`${ok2 ? 'PASS' : 'FAIL'}  stale ref reports, does not throw → ${stale.err}`);
ok2 ? pass++ : fail++;

// session-gone path on a mutating tool: the ⚠️, not a throw
setFakePage(null);
await run('browser_keyboard', { keys: 'Enter' }, '⚠️ no browser session');
await run('browser_form', { values: { q: 'x' } }, '⚠️ no browser session');
await run('browser_scroll', {}, '⚠️ no browser session');
await run('browser_console', { level: 'all' }, '⚠️ no browser session');
setFakePage(new FakePage());

// safeSelector: the guard keeping pseudo/text engines out of evaluate
const selCases = [
  ['#id', true],
  ['.cls', true],
  ['div.foo', true],
  ['input[type=text]', true],
  ['div > .foo', true],
  ['a, b', true],
  ['main section.card', true],
  ['#id .cls > tag[attr="v"]', true],
  ['div :has-text("x")', false],
  ['button:text("x")', false],
  ['div::before', false],
  ['div.foo;', false],
  ['', false],
  ['>', false],
  ['a{color:red}', false],
];
for (const [sel, expectOk] of selCases) {
  const r = safeSelector(sel);
  const ok = expectOk ? !r.err : Boolean(r.err);
  console.log(`${ok ? 'PASS' : 'FAIL'}  safeSelector(${JSON.stringify(sel)}) → ${r.err || 'allowed'}`);
  ok ? pass++ : fail++;
}

clearAdvancedRefs(cid);
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILURE(S)`} — ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
