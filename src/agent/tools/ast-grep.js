// language: JavaScript (Node 20+ ESM), file: src/agent/tools/ast-grep.js
// Structural code search — the oh-my-pi ast_grep tool.
//
// omp's version is ast-grep proper: 50+ tree-sitter grammars, a real pattern
// language. That is a Rust binary we cannot ship. What we CAN do is the
// grammar we actually have — acorn for JS/TS — plus the pattern language that
// makes it structural: `$NAME` captures one node, `$$$ARGS` zero-or-more.
//
// The useful part is not the grammar count, it is the idea: match by shape
// (a call with three args, a catch with an empty body) instead of by text,
// so formatting and comments do not break the match.

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'acorn';
import { config } from '../../config.js';
import { resolveInWorkspace } from '../workspace.js';

const MAX_FILES = 200;
const MAX_HITS = 60;

/**
 * Convert an omp-style pattern into a matcher over AST nodes.
 *
 *   $NAME          — captures one node (any type)
 *   $$$NAME        — matches zero-or-more (in argument lists / arrays / params / blocks)
 *   $_             — matches one node without binding
 *   literal text   — must match structurally
 */
function compilePattern(patStr) {
  const patAst = parseAsExpression(patStr);
  if (!patAst) return { error: 'the pattern does not parse as a single expression — wrap it (e.g. `class $_ { … }`)' };
  return { match: (node, binds) => matchNode(patAst, node, binds) };
}

/**
 * Parse a pattern to one AST node. omp documents the same rule: a pattern must
 * be a single AST node. Fragments that are not standalone on their own get
 * wrapped — `catch ($E) { $$$ }` inside a try, a function body inside a
 * declaration — and the search then matches the inner node.
 */
/**
 * Parse a pattern to one AST node. omp documents the same rule: a pattern must
 * be a single AST node. Fragments that are not standalone on their own get
 * wrapped — `catch ($E) { $$$ }` inside a try — and we return the node that
 * covers exactly the pattern's source region.
 */
function parseAsExpression(src) {
  const opts = { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true, allowHashBang: false };
  try {
    const ast = parse(src, opts);
    if (ast.body.length === 1) {
      const s = ast.body[0];
      return s.type === 'ExpressionStatement' ? s.expression : s;
    }
  } catch {}
  for (const [wrap, prefix] of [
    [`try { } ${src}`, 'try { } '.length],
    [`function _p() ${src}`, 'function _p() '.length],
    [`(() => ${src})`, '(() => '.length],
    [`(${src})`, '('.length],
  ]) {
    try {
      const ast = parse(wrap, opts);
      // the pattern's source region inside the wrapper
      const node = smallestCovering(ast, prefix, prefix + src.length);
      if (node) return node;
    } catch {}
  }
  return null;
}

/** The smallest node whose span contains the whole region — that is the node
 *  for the pattern, not the wrapper around it. */
function smallestCovering(ast, start, end) {
  let best = null;
  const walk = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.start != null && n.end != null && n.start <= start && n.end >= end) {
      if (!best || (n.end - n.start) < (best.end - best.start)) best = n;
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  };
  walk(ast);
  return best;
}
const isMeta = (n) => n?.type === 'Identifier' && /^\$/.test(n.name);
const isRestMarker = (n) => n?.type === 'Identifier' && /^\$\$\$/.test(n.name);

/** `$$$NAME` standing alone in a block parses to ExpressionStatement(Identifier);
 *  unwrap it so the list matcher sees the rest marker. */
function unwrapRestMarker(p) {
  if (p && p.type === 'ExpressionStatement' && isRestMarker(p.expression)) return p.expression;
  return p;
}

function matchNode(pat, node, binds) {
  if (!node || typeof node.type !== 'string') return false;

  // $$$NAME / $NAME / $_ in the pattern position
  if (isMeta(pat)) {
    const name = pat.name;
    if (name === '$_') return true; // matches anything, binds nothing
    if (name.startsWith('$$$')) {
      // zero-or-more is only meaningful inside a list; as a lone node it
      // matches nothing (the list path handles the real case)
      return false;
    }
    // $NAME — capture, or re-match identical code if already bound
    if (Object.prototype.hasOwnProperty.call(binds, name)) {
      return sameCode(binds[name], node);
    }
    binds[name] = node;
    return true;
  }

  if (pat.type !== node.type) return false;

  for (const key of Object.keys(pat)) {
    if (['type', 'start', 'end', 'loc', 'range', 'sourceType', 'raw'].includes(key)) continue;
    const pv = pat[key];
    const nv = node[key];
    if (pv === undefined) continue;
    if (Array.isArray(pv) || Array.isArray(nv)) {
      // A statement list. `catch ($E) { $$$ }` compiles to
      // ExpressionStatement(Identifier('$$$')) sitting in the list — unwrap it
      // so matchList sees a proper rest marker.
      const normPv = (pv || []).map(unwrapRestMarker);
      if (!matchList(normPv, nv || [], binds)) return false;
      continue;
    }
    if (pv && typeof pv === 'object' && pv.type) {
      if (!matchNode(pv, nv, binds)) return false;
      continue;
    }
    // literal field (operator, kind, name)
    if (pv !== nv) return false;
  }
  return true;
}

function matchList(patList, nodeList, binds) {
  const pats = patList.map(unwrapRestMarker);
  if (!pats.length) return nodeList.length === 0;

  const restAt = pats.findIndex((p) => isRestMarker(p));

  if (restAt === -1) {
    if (pats.length !== nodeList.length) return false;
    return pats.every((p, i) => matchNode(p, nodeList[i], binds));
  }

  // exactly one rest slot is supported (the case omp documents)
  const before = pats.slice(0, restAt);
  const after = pats.slice(restAt + 1);
  if (nodeList.length < before.length + after.length) return false;
  for (let i = 0; i < before.length; i++) if (!matchNode(before[i], nodeList[i], binds)) return false;
  for (let i = 0; i < after.length; i++) {
    if (!matchNode(after[i], nodeList[nodeList.length - after.length + i], binds)) return false;
  }
  // bind what the rest matched (the bare `$$$` binds nothing)
  if (pats[restAt].name !== '$$$') binds[pats[restAt].name] = nodeList.slice(before.length, nodeList.length - after.length);
  return true;
}
function sameCode(a, b) {
  if (!a || !b) return a === b;
  if (a.type !== b.type) return false;
  return (a.start != null && b.start != null && a.start === b.start) || JSON.stringify(a) === JSON.stringify(b);
}

/** Walk every node, testing the compiled pattern. */
function searchAst(ast, pat, src, file, out, maxHits) {
  const walk = (node) => {
    if (!node || typeof node.type !== 'string' || out.matches.length >= maxHits) return;
    const binds = {};
    if (pat.match(node, binds)) {
      const line = src.slice(0, node.start).split('\n').length;
      const endLine = src.slice(0, node.end).split('\n').length;
      const snippet = src.slice(node.start, node.end).split('\n')[0].trim().slice(0, 120);
      out.matches.push({ file, line, endLine, snippet, binds: describe(binds) });
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  };
  walk(ast);
}

function describe(binds) {
  const keys = Object.keys(binds).filter((k) => k.startsWith('$') && !k.startsWith('$$$'));
  if (!keys.length) return '';
  return keys.map((k) => `${k}=${(binds[k]?.name || binds[k]?.value || binds[k]?.type || '…')}`).join(', ');
}

export const astGrepTools = [
  {
    name: 'ast_grep',
    description: 'Structural code search over JS/TS: match by syntax shape, not text. $NAME captures one node, $$$ARGS matches zero-or-more, $_ matches without binding. Same metavariable twice must match identical code. Patterns must be a single AST node — wrap non-standalone ones. Narrow the path first; a repo-root scan is slow.',
    isDangerous: false,
    parameters: {
      type: 'object',
      properties: {
        pat: { type: 'string', description: 'The AST pattern, e.g. `fetch($URL)` or `catch ($E) { $$$ }`' },
        path: { type: 'string', description: 'File, directory, or glob; default the workspace root' },
        lang: { type: 'string', description: 'Reserved — JS/TS is all this build parses' },
      },
      required: ['pat'],
      additionalProperties: false,
    },
    async execute({ pat, path: rel }, ctx = {}) {
      const compiled = compilePattern(pat);
      if (compiled.error) return `⚠️ ${compiled.error}`;

      const id = ctx.userId ?? ctx.chatId;
      const root = path.resolve(config.agent.workspace, String(id));
      const target = rel ? path.resolve(root, rel) : root;
      if (target !== root && !target.startsWith(root + path.sep)) return '⚠️ outside the workspace';
      if (!fs.existsSync(target)) return `⚠️ no such path: ${rel}`;

      const out = { matches: [] };
      const JS = new Set(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx']);
      let scanned = 0, parsed = 0, errs = 0;

      const scanFile = (abs) => {
        if (out.matches.length >= MAX_HITS || scanned >= MAX_FILES) return;
        if (!JS.has(path.extname(abs).toLowerCase())) return;
        scanned++;
        const src = fs.readFileSync(abs, 'utf8');
        if (src.length > 512 * 1024) return;
        try {
          const ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true, allowHashBang: true });
          parsed++;
          searchAst(ast, compiled, src, path.relative(root, abs), out, MAX_HITS);
        } catch (e) {
          errs++;
          if (process.env.AG_TRACE) console.error('AG-SKIP', path.relative(root, abs), e.message);
        }
      };

      const walk = (d) => {
        if (out.matches.length >= MAX_HITS || scanned >= MAX_FILES) return;
        let ents;
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          if (out.matches.length >= MAX_HITS || scanned >= MAX_FILES) return;
          const p = path.join(d, e.name);
          if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p); continue; }
          scanFile(p);
        }
      };

      if (fs.statSync(target).isDirectory()) walk(target); else scanFile(target);

      if (!out.matches.length) {
        return `No structural matches for \`${pat}\` — ${parsed} file(s) parsed${errs ? `, ${errs} skipped (JSX or a syntax error)` : ''}${scanned >= MAX_FILES ? `, capped at ${MAX_FILES} files — narrow the path` : ''}.\n\nA parse failure is a query problem, not absence: check the pattern parses on its own, or set a narrower path.`;
      }
      return `**${out.matches.length} match(es)** for \`${pat}\`:\n\n` +
        out.matches.map((m) =>
          `- \`${m.file}:${m.line}${m.endLine !== m.line ? `-${m.endLine}` : ''}\` \`${m.snippet}\`${m.binds ? `  _(${m.binds})_` : ''}`).join('\n');
    },
  },
];

const SKIP = new Set(['node_modules', '.git', 'dist', '.undo', '.checkpoints', 'vendor']);
