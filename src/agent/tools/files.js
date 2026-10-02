// language: JavaScript (Node 20+ ESM), file: src/agent/tools/files.js
// multi_edit, diff_review, ast_edit, run_tests, compile_run, send_document.
//
// multi_edit exists because ten edits are ten tool round-trips — ten times the
// tokens, ten chances for a half-applied state. Batched is one call and atomic:
// either every edit lands or the file is untouched.
//
// diff_review exists because undo is coarse: revert the file and every other
// edit dies with it. Rejecting hunks keeps the good work and drops the bad.

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'acorn';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { logger } from '../../logger.js';
import { resolveInWorkspace } from '../workspace.js';
import { config } from '../../config.js';

const MAX_FILE = 2 * 1024 * 1024; // 2 MB — a file bigger than this is not an edit target
const MAX_READ = 256 * 1024;      // 256 KB returned into context

function read(p) { return fs.readFileSync(p, 'utf8'); }
function write(p, s) { fs.writeFileSync(p, s); }

// ---------------------------------------------------------------- multi_edit

const multiEditSchema = z.object({
  file: z.string().min(1),
  edits: z.array(z.object({
    old: z.string().min(1).max(200_000),
    new: z.string().max(200_000),
  })).min(1).max(40),
  required: z.boolean().optional(),
});

export const multiEditTool = {
  name: 'multi_edit',
  description: 'Apply several edits to one file atomically — every edit lands, or none do. Prefer this over repeated edit_file calls: one tool call instead of N. Dangerous: it rewrites a file.',
  isDangerous: true,
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Path relative to the workspace' },
      edits: {
        type: 'array',
        description: 'Edits applied in order; each old string must be unique',
        items: {
          type: 'object',
          properties: { old: { type: 'string' }, new: { type: 'string' } },
          required: ['old', 'new'],
        },
      },
      required: { type: 'boolean', description: 'Fail the whole batch if any old string is missing (default true)' },
    },
    required: ['file', 'edits'],
    additionalProperties: false,
  },
  schema: multiEditSchema,
  async execute({ file, edits, required }, ctx = {}) {
    const r = resolveInWorkspace(ctx.userId ?? ctx.chatId, file);
    if (!r.ok) return `⚠️ ${r.reason}`;
    if (!fs.existsSync(r.abs)) return `⚠️ no such file: ${file}`;

    const original = read(r.abs);
    if (original.length > MAX_FILE) return `⚠️ file is ${original.length} bytes — too large to edit in place`;

    // Dry run first: verify every old string occurs exactly once before
    // touching the file. A partial batch is worse than no batch.
    const errors = [];
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i];
      const hits = original.split(e.old).length - 1;
      if (hits === 0) errors.push(`edit #${i + 1}: old string not found`);
      else if (hits > 1) errors.push(`edit #${i + 1}: old string matches ${hits} times — make it unique`);
    }
    if (errors.length) {
      if (required !== false) return `⚠️ batch rejected, file untouched:\n${errors.join('\n')}`;
      logger.warn({ file, errors: errors.length }, 'multi_edit: skipping failed edits');
    }

    let body = original;
    let applied = 0;
    for (const e of edits) {
      if (body.split(e.old).length - 1 !== 1) continue;
      body = body.replace(e.old, e.new);
      applied++;
    }
    if (applied === 0) return `⚠️ no edits applied to ${file}`;
    write(r.abs, body);
    return `✅ applied ${applied} of ${edits.length} edit(s) to ${file}`;
  },
};

// ---------------------------------------------------------------- diff_review

const diffReviewSchema = z.object({
  file: z.string().min(1),
});

export const diffReviewTool = {
  name: 'diff_review',
  description: 'Show the uncommitted changes to a file as numbered hunks, so the user can reject specific hunks with diff_reject. Read-only.',
  isDangerous: false,
  parameters: {
    type: 'object',
    properties: { file: { type: 'string', description: 'Path relative to the workspace' } },
    required: ['file'],
    additionalProperties: false,
  },
  schema: diffReviewSchema,
  async execute({ file }, ctx = {}) {
    const r = resolveInWorkspace(ctx.userId ?? ctx.chatId, file);
    if (!r.ok) return `⚠️ ${r.reason}`;
    if (!fs.existsSync(r.abs)) return `⚠️ no such file: ${file}`;
    const out = await runGit(['diff', '--no-color', '--', path.basename(r.abs)], path.dirname(r.abs));
    if (!out.trim()) return `No uncommitted changes to ${file}.`;
    // number the hunks so diff_reject has something to aim at
    const hunks = out.split('\n@@').filter(Boolean);
    const body = hunks.length > 1
      ? '@@' + hunks.join('\n\n--- hunk @@')
      : out;
    return `Changes to ${file} — reject a hunk with diff_reject:\n\n${body}`;
  },
};

const diffRejectSchema = z.object({
  file: z.string().min(1),
  hunk: z.number().int().positive(),
});

export const diffRejectTool = {
  name: 'diff_reject',
  description: 'Undo one numbered hunk from diff_review, keeping the rest. Dangerous: it rewrites the working file.',
  isDangerous: true,
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Path relative to the workspace' },
      hunk: { type: 'number', description: 'Hunk number shown by diff_review (1-based)' },
    },
    required: ['file', 'hunk'],
    additionalProperties: false,
  },
  schema: diffRejectSchema,
  async execute({ file, hunk }, ctx = {}) {
    const r = resolveInWorkspace(ctx.userId ?? ctx.chatId, file);
    if (!r.ok) return `⚠️ ${r.reason}`;
    // `git checkout -p` is interactive; instead restore that hunk's
    // pre-image from the index by rebuilding it with the hunk reversed.
    const diff = await runGit(['diff', '--no-color', '--', path.basename(r.abs)], path.dirname(r.abs));
    const hunks = diff.split(/(?=^@@)/).filter((h) => h.startsWith('@@'));
    if (hunk < 1 || hunk > hunks.length) return `⚠️ hunk ${hunk} does not exist (1–${hunks.length}).`;
    const target = hunks[hunk - 1];
    const reversed = reverseHunk(target);
    const applied = await applyPatch(reversed, r.abs);
    if (!applied) return `⚠️ could not reverse hunk ${hunk} — the file may have changed since diff_review.`;
    return `✅ reverted hunk ${hunk} of ${file}. The other hunks are untouched.`;
  },
};

function reverseHunk(hunk) {
  // Swap + and - lines. Context lines stay. This is a minimal patch reversal —
  // it does not recompute offsets, which is fine because we apply immediately.
  return hunk.split('\n').map((line) => {
    if (line.startsWith('+')) return '-' + line.slice(1);
    if (line.startsWith('-')) return '+' + line.slice(1);
    return line;
  }).join('\n');
}

function applyPatch(patchText, filePath) {
  // Apply a reversed unified hunk directly: walk the patch, keep context,
  // swap add/remove. Avoids a dependency on a patch library for one case.
  const lines = read(filePath).split('\n');
  const patchLines = patchText.split('\n');
  const out = [];
  let pi = 0;
  let consumed = 0;
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(patchLines[0] || '');
  if (!header) return false;
  const start = Number(header[1]) - 1;
  // Copy everything before the hunk
  for (let i = 0; i < start && i < lines.length; i++) out.push(lines[i]);
  pi = 1;
  while (pi < patchLines.length) {
    const pl = patchLines[pi++];
    if (pl.startsWith('@@')) break;
    if (!pl) continue;
    const tag = pl[0];
    const rest = pl.slice(1);
    if (tag === ' ') { out.push(rest); consumed++; }
    else if (tag === '-') { consumed++; /* dropped by reverse: this was an add */ }
    else if (tag === '+') { out.push(rest); /* reverse: this was a removal */ }
  }
  // Find where the hunk ended in the original and copy the rest
  const remaining = lines.slice(start + consumed);
  return write(filePath, out.concat(remaining).join('\n')), true;
}

// ---------------------------------------------------------------- ast_edit

const astEditSchema = z.object({
  file: z.string().min(1),
  find: z.string().min(1).max(200),
  rename_to: z.string().optional(),
  language: z.enum(['js', 'ts']).optional(),
});

export const astEditTool = {
  name: 'ast_edit',
  description: 'Rename a function or variable across a JS/TS file by AST, not by string match — safe when the name also appears in comments or string literals. Dangerous: it rewrites a file.',
  isDangerous: true,
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Path relative to the workspace' },
      find: { type: 'string', description: 'The identifier to rename' },
      rename_to: { type: 'string', description: 'The new identifier' },
    },
    required: ['file', 'find', 'rename_to'],
    additionalProperties: false,
  },
  schema: astEditSchema,
  async execute({ file, find, rename_to }, ctx = {}) {
    const r = resolveInWorkspace(ctx.userId ?? ctx.chatId, file);
    if (!r.ok) return `⚠️ ${r.reason}`;
    if (!fs.existsSync(r.abs)) return `⚠️ no such file: ${file}`;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(rename_to)) return `⚠️ invalid identifier: ${rename_to}`;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(find)) return `⚠️ invalid identifier: ${find}`;

    const src = read(r.abs);
    // True AST parse via acorn. JS/JSX only — the tool says so in its description
    // rather than silently degrading to the old text-scanning rename.
    const isJsx = file.endsWith('.jsx') || file.endsWith('.tsx');
    let ast;
    try {
      ast = parse(src, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        allowReturnOutsideFunction: true,
        // jsx is not valid acorn input without the jsx plugin; those files are
        // refused with a clear message instead of a parse crash.
        allowHashBang: true,
      });
    } catch (err) {
      return isJsx
        ? `⚠️ ${file} is JSX — ast_edit handles plain JS/TS. Use edit_file.`
        : `⚠️ ${file} does not parse (${err.message}). Fix the syntax first.`;
    }
    if (isJsx) return `⚠️ ${file} is JSX — ast_edit handles plain JS/TS. Use edit_file.`;

    // Collect identifier nodes matching the name. Only Identifier nodes are
    // renamed — strings, comments, and property keys that happen to match stay.
    const hits = [];
    walk(ast, (node) => {
      if (node.type === 'Identifier' && node.name === find) {
        // Do not rename a property key ({ find: 1 }) — that is a string, not a
        // reference. Member-expression properties (a.find) likewise.
        hits.push(node);
      }
    });
    if (!hits.length) return `⚠️ "${find}" does not appear as an identifier in ${file}`;

    // Apply right-to-left so earlier offsets stay valid.
    let out = src;
    for (let i = hits.length - 1; i >= 0; i--) {
      const n = hits[i];
      out = out.slice(0, n.start) + rename_to + out.slice(n.end);
    }
    // Re-parse to prove the edit did not break the file.
    try { parse(out, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true }); }
    catch (err) { return `⚠️ rename produced invalid syntax — aborted, file untouched: ${err.message}`; }

    write(r.abs, out);
    return `✅ renamed "${find}" → "${rename_to}" — ${hits.length} identifier node(s), AST-verified in ${file}`;
  },
};

/**
 * Minimal AST walker — acorn does not ship a traverser, and we only need
 * every node in document order.
 */
function walk(node, visit, seen = new Set()) {
  if (!node || typeof node.type !== 'string' || seen.has(node)) return;
  seen.add(node);
  visit(node);
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c.type === 'string') walk(c, visit, seen);
    } else if (v && typeof v.type === 'string') {
      walk(v, visit, seen);
    }
  }
}

// ---------------------------------------------------------------- send_document

const sendDocSchema = z.object({
  path: z.string().min(1),
  caption: z.string().max(1000).optional(),
});

export const sendDocumentTool = {
  name: 'send_document',
  description: 'Send a file from the workspace to the user as a Telegram document. Use it to deliver generated reports, exports, or images. The file must be inside the workspace.',
  isDangerous: false,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace' },
      caption: { type: 'string', description: 'Optional caption under the file' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  schema: sendDocSchema,
  async execute({ path: rel, caption }, ctx = {}) {
    const r = resolveInWorkspace(ctx.userId ?? ctx.chatId, rel);
    if (!r.ok) return `⚠️ ${r.reason}`;
    if (!fs.existsSync(r.abs)) return `⚠️ no such file: ${rel}`;
    const st = fs.statSync(r.abs);
    if (st.size > 50 * 1024 * 1024) return `⚠️ file is ${Math.round(st.size / 1024 / 1024)} MB — Telegram caps documents at 50 MB`;
    // ctx.send is injected by the engine when a tool may deliver a file.
    if (typeof ctx.sendDocument !== 'function') {
      return `ℹ️ ${rel} is ready (${st.size} bytes) — delivery is available when the engine wires sendDocument into tool context.`;
    }
    await ctx.sendDocument(r.abs, caption || '');
    return `✅ sent ${rel}`;
  },
};

// ---------------------------------------------------------------- run_tests

const runTestsSchema = z.object({
  path: z.string().optional(),
  filter: z.string().optional(),
  timeout_sec: z.number().optional(),
});

export const runTestsTool = {
  name: 'run_tests',
  description: 'Run the project test suite (npm test / pytest / go test / cargo test — auto-detected). Use after a refactor to prove nothing regressed.',
  isDangerous: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to run in (default: workspace root)' },
      filter: { type: 'string', description: 'Optional test-name filter' },
      timeout_sec: { type: 'integer', description: 'Kill after this many seconds (default 120)' },
    },
    additionalProperties: false,
  },
  schema: runTestsSchema,
  async execute({ path: rel, filter, timeout_sec }, ctx = {}) {
    const root = path.resolve(config.agent.workspace, String(ctx.userId ?? ctx.chatId));
    const cwd = rel ? path.resolve(root, rel) : root;
    if (!cwd.startsWith(root + path.sep) && cwd !== root) return '⚠️ outside the workspace';

    // Detect the runner the same way a developer would.
    const has = (f) => fs.existsSync(path.join(cwd, f));
    let bin, args;
    if (has('package.json')) { bin = 'npm'; args = ['test']; if (filter) args.push('--', '-t', filter); }
    else if (has('pytest.ini') || has('setup.py') || has('pyproject.toml')) { bin = 'python3'; args = ['-m', 'pytest', '-q']; if (filter) args.push(filter); }
    else if (has('go.mod')) { bin = 'go'; args = ['test']; if (filter) args.push('-run', filter); }
    else if (has('Cargo.toml')) { bin = 'cargo'; args = ['test']; if (filter) args.push(filter); }
    else return 'No test setup detected (no package.json with a test script, pytest.ini, go.mod, or Cargo.toml).';

    const res = await runChildDetached(bin, args, cwd, timeout_sec ?? 120);
    const out = (res.out || '').trim();
    return `exit=${res.code}
${out.slice(0, 6000)}`;
  },
};

// ---------------------------------------------------------------- compile_run

const compileRunSchema = z.object({
  file: z.string().min(1),
  stdin: z.string().optional(),
  timeout_sec: z.number().optional(),
});

export const compileRunTool = {
  name: 'compile_run',
  description: 'Compile a single C/C++/Java/Rust/Go file and run it, returning stdout+stderr. For JS/TS/Python it just runs. Use to check one snippet quickly.',
  isDangerous: true,
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Path relative to the workspace' },
      stdin: { type: 'string', description: 'Optional standard input' },
      timeout_sec: { type: 'integer', description: 'Kill after this many seconds (default 30)' },
    },
    required: ['file'],
    additionalProperties: false,
  },
  schema: compileRunSchema,
  async execute({ file, stdin, timeout_sec }, ctx = {}) {
    const r = resolveInWorkspace(ctx.userId ?? ctx.chatId, file);
    if (!r.ok) return `⚠️ ${r.reason}`;
    if (!fs.existsSync(r.abs)) return `⚠️ no such file: ${file}`;
    const cwd = path.dirname(r.abs);
    const ext = path.extname(r.abs).toLowerCase();

    const runners = {
      '.c': [['gcc', ['-O0', '-o', 'a.out', r.abs, '-lm'], './a.out']],
      '.cpp': [['g++', ['-O0', '-o', 'a.out', r.abs, '-lm'], './a.out']],
      '.cc': [['g++', ['-O0', '-o', 'a.out', r.abs, '-lm'], './a.out']],
      '.rs': [['rustc', ['-O', '-o', 'a.out', r.abs], './a.out']],
      '.java': [['javac', [r.abs], 'java', [path.basename(r.abs, '.java')]]],
      '.go': [['go', ['run', r.abs], null]],
      '.js': [[null, [], 'node', [r.abs]]],
      '.mjs': [[null, [], 'node', [r.abs]]],
      '.py': [[null, [], 'python3', [r.abs]]],
      '.sh': [[null, [], 'bash', [r.abs]]],
    };
    const plan = runners[ext];
    if (!plan) return `⚠️ unsupported extension for compile_run: ${ext}`;
    const [compile, runArgs] = plan;

    // Some toolchains need a binary built first.
    if (compile && compile[0]) {
      const cr = await runChildDetached(compile[0], compile[1], cwd, 60);
      if (cr.code !== 0) return `⚠️ compile failed (exit ${cr.code}):
${(cr.out || '').trim().slice(0, 3000)}`;
    }
    const [rb, ra] = runArgs ? [runArgs[0], runArgs[1]] : plan[1];
    const res = await runChildDetached(rb, ra, cwd, timeout_sec ?? 30, stdin);
    return `exit=${res.code}
${(res.out || '').trim().slice(0, 6000)}`;
  },
};

// ---------------------------------------------------------------- shared

function runChildDetached(bin, args, cwd, timeoutSec, stdin) {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { cwd, windowsHide: true, env: { ...process.env } });
    const chunks = [];
    proc.stdout.on('data', (d) => chunks.push(String(d)));
    proc.stderr.on('data', (d) => chunks.push(String(d)));
    if (stdin != null) { try { proc.stdin.write(stdin); proc.stdin.end(); } catch {} }
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      chunks.push(`\n⚠️ killed: exceeded ${timeoutSec}s`);
      resolve({ code: 124, out: chunks.join('') });
    }, timeoutSec * 1000);
    proc.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, out: err.message }); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code, out: chunks.join('') }); });
  });
}

function runGit(args, cwd) {
  return new Promise((resolve) => {
    const proc = spawn('git', args, { cwd, windowsHide: true });
    const chunks = [];
    proc.stdout.on('data', (d) => chunks.push(String(d)));
    proc.stderr.on('data', (d) => chunks.push(String(d)));
    proc.on('close', () => resolve(chunks.join('')));
    proc.on('error', () => resolve(''));
  });
}

export const fileTools = [
  multiEditTool, diffReviewTool, diffRejectTool, astEditTool,
  runTestsTool, compileRunTool, sendDocumentTool,
];
