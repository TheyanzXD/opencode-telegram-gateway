// language: JavaScript (Node 20+ ESM), file: tests/camoufox-stub.mjs
// In-memory stand-in for src/browser/camoufox.js, so the browser-tool smoke
// test never launches a real browser. Two things live here:
//
//   1. the fake camoufox API the tool modules import (getPage, sessionActive…)
//   2. a loader hook the smoke test registers, which replaces the real
//      camoufox.js with this file at load time — no tool source changes
//
// setFakePage(null) simulates "no browser session for this chat".
//
// The loader runs in its own thread with its own module registry, so this
// module's own state is not the state the tools see. The page travels through
// a global instead — one object, visible from both sides.

export function setFakePage(page) { globalThis.__CAMOUFOX_STUB_PAGE = page; }

export async function getPage(_chatId) { return globalThis.__CAMOUFOX_STUB_PAGE ?? null; }

export function sessionActive(_chatId) {
  const p = globalThis.__CAMOUFOX_STUB_PAGE;
  return Boolean(p && !p.isClosed?.());
}

export function camoufoxInstalled() { return true; }

export async function camouClose(_chatId) { globalThis.__CAMOUFOX_STUB_PAGE = null; }

export async function camouSearch(_query, _opts) {
  return { engine: 'stub', results: [{ title: 'stub', url: 'https://example.test/', snippet: 's' }] };
}

export async function camouBrowse(url, _opts) {
  return { title: 'stub', url, text: 'stub' };
}

// ------------------------------------------------------- the loader
//
// The tools import src/browser/camoufox.js at module scope. load() answers
// that URL with this file's source, so the tools get the fake API above.
// resolve() is not needed: the import specifier resolves on its own, and load
// is where the content decision happens.
export async function load(url, context, nextLoad) {
  if (url.endsWith('/src/browser/camoufox.js')) {
    return { format: 'module', shortCircuit: true, responseURL: url, source: STUB_SOURCE };
  }
  return nextLoad(url, context);
}

// The source handed to load(). Reads this file from disk once, at module
// scope, in the loader's thread — the tools' instance of the stub is this
// exact code, so its behaviour stays in one place.
const STUB_SOURCE = await readFileText(new URL(import.meta.url));
async function readFileText(url) {
  const { readFile } = await import('node:fs/promises');
  return readFile(url, 'utf8');
}
