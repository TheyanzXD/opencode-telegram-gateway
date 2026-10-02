// language: JavaScript (Node 20+ ESM), file: src/agent/tools/code-intel.js
// The code-understanding pillar: RAG search, symbol map, dependency graph.
//
// These read the workspace and answer questions about it without forcing the
// model to read whole files into context. semantic_code_search is the RAG
// entry point; code_symbols and dependency_graph are the structural view.
//
// What "smart" means here: index once, reuse. A file whose content hash is
// unchanged is skipped, so asking again costs nothing.

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'acorn';
import { config } from '../../config.js';
import { indexFile, unindexFile, search, indexStatus, chunkText } from '../embeddings.js';
import { resolveInWorkspace } from '../workspace.js';

function ws(userId) {
  return path.resolve(config.agent.workspace, String(userId ?? 0));
}

/** Index every readable code file under the workspace (bounded). */
async function indexAll(userId, chatId, maxFiles = 400) {
  const root = ws(userId);
  const files = [];
  (function walk(dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        walk(path.join(dir, e.name));
      } else if (CODE_EXT.has(path.extname(e.name).toLowerCase())) {
        files.push(path.join(dir, e.name));
      }
    }
  })(root);
  const slice = files.slice(0, maxFiles);
  let added = 0, errors = 0;
  for (const abs of slice) {
    try {
      const content = fs.readFileSync(abs, 'utf8');
      const { added: a } = await indexFile(userId, path.relative(root, abs), content, chatId);
      added += a;
    } catch { errors++; }
  }
  return { indexed: slice.length, added, errors, skipped: files.length - slice.length };
}

const CODE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.java',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php', '.md', '.txt', '.json',
  '.yaml', '.yml', '.sh', '.sql',
]);
const SKIP = new Set(['node_modules', '.git', 'dist', '.undo', 'vendor', '__pycache__']);

/** List symbols (functions/classes/exports) from a JS/TS file via AST. */
function listSymbols(abs) {
  const src = fs.readFileSync(abs, 'utf8');
  const out = [];
  let ast;
  try {
    ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true, allowHashBang: true });
  } catch (err) {
    return { symbols: [], error: err.message };
  }
  const loc = (n) => {
    const line = src.slice(0, n.start).split('\n').length;
    return line;
  };
  const walk = (node, depth, parent) => {
    if (!node || typeof node.type !== 'string') return;
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'ClassDeclaration' ||
      node.type === 'MethodDefinition' ||
      node.type === 'PropertyDefinition' ||
      node.type === 'VariableDeclarator' ||
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'ExportDefaultDeclaration'
    ) {
      const name = node.id?.name || node.key?.name || (node.declaration?.id?.name) || null;
      if (name) out.push({ name, kind: node.type, line: loc(node), parent: parent || null });
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (Array.isArray(v)) v.forEach((c) => walk(c, depth + 1, nameOf(node)));
      else if (v && typeof v.type === 'string') walk(v, depth + 1, nameOf(node));
    }
  };
  const nameOf = (n) => n.id?.name || n.key?.name || null;
  walk(ast, 0, null);
  return { symbols: out.slice(0, 120), error: null };
}

/** Parse import/require statements from a file. */
function listImports(abs) {
  const src = fs.readFileSync(abs, 'utf8');
  const out = [];
  try {
    const ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true, allowHashBang: true });
    walkImports(ast, out);
  } catch {
    // fall back to regex for files that are not valid on their own (d.ts, jsx)
    const re = /(?:^|\n)\s*(?:import\s[^'"]*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\))/g;
    let m;
    while ((m = re.exec(src))) out.push(m[1] || m[2]);
  }
  return [...new Set(out)];
}

function walkImports(node, out) {
  if (!node || typeof node.type !== 'string') return;
  if (node.type === 'ImportDeclaration' && node.source?.value) out.push(node.source.value);
  if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'require') {
    const a = node.arguments?.[0];
    if (a?.type === 'Literal' && typeof a.value === 'string') out.push(a.value);
  }
  if (node.type === 'ExportNamedDeclaration' && node.source?.value) out.push(node.source.value);
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => walkImports(c, out));
    else if (v && typeof v.type === 'string') walkImports(v, out);
  }
}

export const codeIntelTools = [
  {
    name: 'semantic_code_search',
    description: 'Search the user\'s workspace for code by meaning, not exact text — "where do we handle retry" finds the function even if the word retry never appears. Indexes once and reuses the index. Returns matching chunks with file and line numbers.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, in plain words' },
        limit: { type: 'integer', description: 'Max chunks to return (default 8)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute({ query, limit = 8 }, ctx = {}) {
      const id = ctx.userId ?? ctx.chatId;
      if (!query.trim()) return '⚠️ empty query';
      const hits = await search(id, query, limit, ctx.chatId);
      if (!hits.length) {
        return `No matches for "${query}". The workspace may not be indexed yet — run code_index first, or the file may not exist.`;
      }
      return hits.map((h, i) =>
        `### ${i + 1}. ${h.file}:${h.start_line}-${h.end_line} (score ${(h.score ?? 0).toFixed(2)})\n\`\`\`\n${h.text.slice(0, 900)}\n\`\`\``).join('\n\n');
    },
  },

  {
    name: 'code_index',
    description: 'Index the user\'s workspace so semantic_code_search and code_symbols work. Idempotent — files that have not changed are skipped. Call this once before the first semantic search, and again after large edits.',
    isDangerous: false,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional: index one file or directory instead of the whole workspace' },
      },
      additionalProperties: false,
    },
    async execute({ path: rel }, ctx = {}) {
      const id = ctx.userId ?? ctx.chatId;
      const root = ws(id);
      if (rel) {
        const r = resolveInWorkspace(id, rel);
        if (!r.ok) return `⚠️ ${r.reason}`;
        if (!fs.existsSync(r.abs)) return `⚠️ no such file: ${rel}`;
        if (fs.statSync(r.abs).isDirectory()) {
          let n = 0;
          (function walk(dir) {
            let ents;
            try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const e of ents) {
              if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(path.join(dir, e.name)); continue; }
              if (!CODE_EXT.has(path.extname(e.name).toLowerCase())) continue;
              try { indexFile(id, path.relative(root, path.join(dir, e.name)), fs.readFileSync(path.join(dir, e.name), 'utf8'), ctx.chatId); n++; } catch {}
            }
          })(r.abs);
          return `Indexed ${n} file(s) under ${rel}.`;
        }
        const { added } = await indexFile(id, path.relative(root, r.abs), fs.readFileSync(r.abs, 'utf8'), ctx.chatId);
        return `Indexed ${rel} — ${added} chunk(s). ${JSON.stringify(indexStatus())}`;
      }
      const res = await indexAll(id, ctx.chatId);
      return `Indexed ${res.indexed} file(s), ${res.added} chunk(s)${res.errors ? `, ${res.errors} unreadable` : ''}${res.skipped ? `, ${res.skipped} skipped (cap)` : ''}. Backend: ${indexStatus().vectorBackend} / ${indexStatus().embeddingModel}.`;
    },
  },

  {
    name: 'code_symbols',
    description: 'List the functions, classes, and exports defined in a file with line numbers — the map of what is where. Uses a real AST parse for JS/TS.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path relative to the workspace' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    async execute({ file }, ctx = {}) {
      const r = resolveInWorkspace(ctx.userId ?? ctx.chatId, file);
      if (!r.ok) return `⚠️ ${r.reason}`;
      if (!fs.existsSync(r.abs)) return `⚠️ no such file: ${file}`;
      const { symbols, error } = listSymbols(r.abs);
      if (error) return `⚠️ ${file} does not parse (${error.slice(0, 160)}). Symbols unavailable — the file may be JSX or have a syntax error.`;
      if (!symbols.length) return `No named symbols found in ${file}.`;
      return symbols.map((s) => `- L${s.line} ${s.kind} ${s.name}${s.parent ? ` (in ${s.parent})` : ''}`).join('\n');
    },
  },

  {
    name: 'dependency_graph',
    description: 'Show what a file imports, and which files import it — the blast radius of a change. Answers "if I edit this, what breaks".',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path relative to the workspace' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    async execute({ file }, ctx = {}) {
      const id = ctx.userId ?? ctx.chatId;
      const root = ws(id);
      const r = resolveInWorkspace(id, file);
      if (!r.ok) return `⚠️ ${r.reason}`;
      if (!fs.existsSync(r.abs)) return `⚠️ no such file: ${file}`;

      const imports = listImports(r.abs).filter(Boolean);
      // Resolve each import to a real file in the workspace when possible.
      const resolved = imports.map((spec) => {
        if (!spec.startsWith('.')) return { spec, target: null, kind: 'external' };
        const base = path.resolve(path.dirname(r.abs), spec);
        for (const ext of ['', '.js', '.mjs', '.cjs', '.ts', '.jsx', '/index.js', '/index.ts']) {
          if (fs.existsSync(base + ext)) return { spec, target: path.relative(root, base + ext), kind: 'local' };
        }
        return { spec, target: null, kind: 'local-not-found' };
      });

      // Reverse: who imports this file? A workspace-wide scan, bounded.
      const dependents = [];
      let scanned = 0;
      (function walk(dir) {
        let ents;
        if (scanned > 600 || dependents.length > 40) return;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          if (scanned > 600 || dependents.length > 40) return;
          const p = path.join(dir, e.name);
          if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p); continue; }
          if (!CODE_EXT.has(path.extname(e.name).toLowerCase())) continue;
          scanned++;
          const rel2 = path.relative(root, p);
          if (rel2 === file) continue;
          try {
            const list = listImports(p);
            for (const spec of list) {
              if (!spec.startsWith('.')) continue;
              const base = path.resolve(path.dirname(p), spec);
              for (const ext of ['', '.js', '.mjs', '.cjs', '.ts', '.jsx', '/index.js', '/index.ts']) {
                if (path.relative(root, base + ext) === file) { dependents.push(rel2); break; }
              }
            }
          } catch {}
        }
      })(root);

      const out = [`**${file} imports** (${imports.length}):`];
      out.push(...resolved.map((x) => `- ${x.kind === 'external' ? '📦' : x.target ? '🔗' : '❓'} \`${x.spec}\`${x.target ? ` → ${x.target}` : ''}`));
      out.push('');
      out.push(`**Imported by** (${dependents.length}):`);
      out.push(...(dependents.length ? dependents.map((d) => `- \`${d}\``) : ['- nothing in this workspace imports it (yet)']));
      if (scanned >= 600) out.push('\n_Scan capped at 600 files — a very large workspace may have more dependents._');
      return out.join('\n');
    },
  },

  {
    name: 'dead_code_scan',
    description: 'Find exported functions and variables that are never imported anywhere in the workspace — likely dead code. Bounded scan, heuristic (a name used in a string is not counted).',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Optional: limit the scan to a directory' },
      },
      additionalProperties: false,
    },
    async execute({ dir: rel }, ctx = {}) {
      const id = ctx.userId ?? ctx.chatId;
      const root = ws(id);
      const scanRoot = rel ? path.resolve(root, rel) : root;
      if (!scanRoot.startsWith(root + path.sep) && scanRoot !== root) return '⚠️ outside the workspace';

      // Collect exports and usages across the tree.
      const exported = new Map(); // name -> [files]
      const used = new Set();
      let scanned = 0;
      (function walk(d) {
        let ents;
        if (scanned > 500) return;
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          if (scanned > 500) return;
          const p = path.join(d, e.name);
          if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p); continue; }
          if (!CODE_EXT.has(path.extname(e.name).toLowerCase())) continue;
          scanned++;
          try {
            const src = fs.readFileSync(p, 'utf8');
            // exports: `export function foo`, `export const foo`, `export { foo }`
            const reFn = /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g;
            const reConst = /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
            const reNamed = /export\s*\{([^}]*)\}/g;
            let m;
            while ((m = reFn.exec(src))) push(exported, m[1], path.relative(root, p));
            while ((m = reConst.exec(src))) push(exported, m[1], path.relative(root, p));
            while ((m = reNamed.exec(src))) {
              for (const part of m[1].split(',')) {
                const name = part.split(/\s+as\s+/)[0].trim();
                if (/^[A-Za-z_$][\w$]*$/.test(name)) push(exported, name, path.relative(root, p));
              }
            }
            // usages: imported names, and any reference at all
            const reImport = /import\s*(?:[^'"]*\s)?\{([^}]*)\}|import\s+([A-Za-z_$][\w$]*)\s+from/g;
            while ((m = reImport.exec(src))) {
              if (m[1]) for (const part of m[1].split(',')) { const n = part.split(/\s+as\s+/)[0].trim(); if (n) used.add(n); }
              if (m[2]) used.add(m[2]);
            }
          } catch {}
        }
      })(scanRoot);

      // An export is "used" if it is imported anywhere, or appears as an
      // identifier in a file that is not its own (call site).
      const dead = [];
      for (const [name, files] of exported) {
        if (used.has(name)) continue;
        // second pass: identifier occurrence outside its own file
        let foundElsewhere = false;
        for (const f of files) {
          const abs = path.resolve(root, f);
          try {
            const src = fs.readFileSync(abs, 'utf8');
            const re = new RegExp(`\\b${name}\\b`);
            if (re.test(src)) { foundElsewhere = true; break; }
          } catch {}
        }
        if (!foundElsewhere) dead.push({ name, files });
      }
      if (scanned >= 500) return `Scan capped at 500 files. Partial result: ${dead.length} candidate(s).`;
      if (!dead.length) return `No obviously-dead exports found across ${scanned} file(s).`;
      return dead.slice(0, 30).map((d) => `- \`${d.name}\` — exported by ${d.files.slice(0, 3).join(', ')}${d.files.length > 3 ? ` +${d.files.length - 3}` : ''}`).join('\n') + `\n\n_Heuristic: never imported and never referenced outside its own file. Verify before deleting._`;
    },
  },
];

function push(map, name, file) {
  if (!map.has(name)) map.set(name, []);
  if (!map.get(name).includes(file)) map.get(name).push(file);
}
