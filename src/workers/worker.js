// language: JavaScript (Node 20+ ESM), file: src/workers/worker.js
// Worker-side task runner. Runs INSIDE the worker thread, off the event loop.
//
// The parent sends { name, payload }; this looks the name up in TASKS and calls
// it. Only registered functions are callable — the worker never evaluates a
// string from the payload, so a malicious task name or payload cannot inject
// code into the worker.

import { parentPort } from 'node:worker_threads';

// A task is a pure function (payload) => result. Impure tasks (fs, net) are
// deliberately excluded from here: the point is CPU offload, and anything that
// touches disk or the network belongs in the main process where the sandbox
// and the tool gates can see it.
const TASKS = {
  /**
   * AST scan of a JS/TS source for high-risk constructs. acorn is already a
   * dependency; parsing a large file is exactly the kind of synchronous work
   * that would stall the loop if it ran inline.
   */
  astScan: (payload) => {
    const { source } = payload || {};
    if (typeof source !== 'string' || !source.length) return { hits: [] };
    // required here, inside the worker, so the main process never loads it.
    // createRequire keeps this working whether the file is loaded as ESM or CJS.
    const { createRequire } = require('node:module');
    const require2 = createRequire(import.meta.url);
    const { parse } = require2('acorn');
    const hits = [];
    const DANGEROUS = new Set([
      'eval', 'Function', 'require', 'child_process', 'spawn', 'spawnSync',
      'exec', 'execSync', 'fetch', 'http', 'https', 'net', 'dgram', 'fs',
    ]);
    const visit = (node) => {
      if (!node || typeof node.type !== 'string') return;
      if (node.type === 'CallExpression') {
        const callee = node.callee;
        const name = callee?.name || (callee?.property?.name ?? null);
        if (name && DANGEROUS.has(name)) {
          hits.push({ type: 'call', name, line: node.loc?.start?.line });
        }
      }
      if (node.type === 'ImportDeclaration' && node.source?.value) {
        if (DANGEROUS.has(String(node.source.value))) {
          hits.push({ type: 'import', name: String(node.source.value), line: node.loc?.start?.line });
        }
      }
      for (const key of Object.keys(node)) {
        const child = node[key];
        if (Array.isArray(child)) child.forEach(visit);
        else if (child && typeof child.type === 'string') visit(child);
      }
    };
    try {
      const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
      visit(ast);
    } catch (err) {
      return { hits: [], parseError: err.message };
    }
    return { hits };
  },

  /** Heavy regex sweep over a long text — e.g. secret redaction on a big log. */
  redactScan: (payload) => {
    const { text } = payload || {};
    if (typeof text !== 'string') return { text: '' };
    const PATTERNS = [
      [/\d{8,10}:[A-Za-z0-9_-]{35}/g, '[REDACTED_TELEGRAM_TOKEN]'],
      [/sk-ant-[A-Za-z0-9_-]{32,}/g, '[REDACTED_ANTHROPIC_KEY]'],
      [/sk-[A-Za-z0-9]{32,}/g, '[REDACTED_OPENAI_KEY]'],
      [/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED_GEMINI_KEY]'],
    ];
    let s = text;
    for (const [re, mask] of PATTERNS) s = s.replace(re, mask);
    return { text: s };
  },

  /** Vector-ish math for local embeddings: cosine similarity over two vectors. */
  cosineSimilarity: (payload) => {
    const { a, b } = payload || {};
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += (a[i] || 0) * (b[i] || 0);
      na += (a[i] || 0) ** 2;
      nb += (b[i] || 0) ** 2;
    }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  },
};

parentPort?.on('message', async (msg) => {
  const { name, payload } = msg || {};
  const task = TASKS[name];
  if (!task) {
    parentPort.postMessage({ error: `unknown worker task: ${name}` });
    return;
  }
  try {
    const result = await task(payload || {});
    parentPort.postMessage({ result });
  } catch (err) {
    parentPort.postMessage({ error: err?.message || 'worker task failed' });
  }
});
