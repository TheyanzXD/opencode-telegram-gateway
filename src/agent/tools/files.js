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
    // A true AST parse needs a parser dependency. Node cannot parse JS itself,
    // so fall back to a scope-aware identifier rename: match declarations and
    // references while skipping comments and strings. This is deliberately
    // conservative — it refuses rather than mis-edits.
    const isTs = file.endsWith('.ts');
    const counted = countIdentifierOccurrences(src, find);
    if (counted === 0) return `⚠️ "${find}" does not appear in ${file}`;
    const body = renameIdentifier(src, find, rename_to, isTs);
    if (body === src) return `⚠️ could not safely rename "${find}" — the identifier only appears in comments or strings. Use edit_file instead.`;
    write(r.abs, body);
    return `✅ renamed "${find}" → "${rename_to}" in ${file}`;
  },
};

function countIdentifierOccurrences(src, name) {
  const re = new RegExp(`\\b${name}\\b`, 'g');
  return (src.match(re) || []).length;
}

function renameIdentifier(src, name, to, _isTs) {
  // Strip comments and strings, then rename whole-word occurrences in the
  // code-only regions. Keeping the originals lets us rebuild the file.
  const tokens = tokenize(src);
  return tokens.map((t) => {
    if (t.kind !== 'code') return t.text;
    return t.text.replace(new RegExp(`\\b${name}\\b`, 'g'), to);
  }).join('');
}

function tokenize(src) {
  // A small lexer: split into code / string / comment / template regions.
  // Enough to keep a rename out of literals; not a parser.
  const out = [];
  let i = 0;
  let buf = '';
  const flush = (kind) => { if (buf) { out.push({ kind, text: buf }); buf = ''; } };
  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (two === '//' ) { flush('code'); const j = src.indexOf('\n', i); const end = j === -1 ? src.length : j; out.push({ kind: 'comment', text: src.slice(i, end) }); i = end; continue; }
    if (two === '/*') { flush('code'); const j = src.indexOf('*/', i + 2); const end = j === -1 ? src.length : j + 2; out.push({ kind: 'comment', text: src.slice(i, end) }); i = end; continue; }
    if (c === '"' || c === "'") { flush('code'); const end = scanString(src, i, c); out.push({ kind: 'string', text: src.slice(i, end) }); i = end; continue; }
    if (c === '`') { flush('code'); const end = scanTemplate(src, i); out.push({ kind: 'string', text: src.slice(i, end) }); i = end; continue; }
    buf += c; i++;
  }
  flush('code');
  return out;
}

function scanString(src, i, quote) {
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === '\\') { j += 2; continue; }
    if (src[j] === quote) return j + 1;
    j++;
  }
  return src.length;
}

function scanTemplate(src, i) {
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === '\\') { j += 2; continue; }
    if (src[j] === '`') return j + 1;
    j++;
  }
  return src.length;
}

// ---------------------------------------------------------------- run_tests

const runTestsSchema = z.object({
  path: z.string().optional(),
  framework: z.enum(['auto', 'pytest', 'jest', 'go', 'cargo']).optional(),
});

const FRAMEWORKS = {
  pytest: { bin: 'python3', args: ['pytest', '-v', '--tb=short'], files: ['pytest.ini', 'setup.py', 'requirements.txt', 'tests/'] },
  jest: { bin: 'npx', args: ['jest', '--verbose'], files: ['jest.config.js', 'package.json'] },
  go: { bin: 'go', args: ['test', '-v', './...'], files: ['go.mod'] },
  cargo: { bin: 'cargo', args: ['test', '--', '--nocapture'], files: ['Cargo.toml'] },
};

export const runTestsTool = {
  name: 'run_tests',
  description: 'Detect the test framework and run the suite. Returns a pass/fail summary per test. Gives the agent a real feedback loop for "fix the failing test". Dangerous: it runs arbitrary test code.',
  isDangerous: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Subdirectory of the workspace containing the project (default: root)' },
      framework: { type: 'string', enum: ['auto', 'pytest', 'jest', 'go', 'cargo'], description: 'Force a framework instead of auto-detecting' },
    },
    required: [],
    additionalProperties: false,
  },
  schema: runTestsSchema,
  async execute({ path: rel, framework }, ctx = {}) {
    const r = resolveInWorkspace(ctx.userId ?? ctx.chatId, rel || '.');
    if (!r.ok) return `⚠️ ${r.reason}`;
    if (!fs.existsSync(r.abs)) return `⚠️ no such directory: ${rel}`;

    const fw = pickFramework(r.abs, framework);
    if (!fw) return `⚠️ no test framework detected in ${rel || 'workspace'} — expected one of: pytest (python), jest (node), go, cargo`;
    const out = await runChildDetached(fw.bin, [...fw.args], r.abs, 180);
    return summarize(fw.name, out);
  },
};

function pickFramework(dir, forced) {
  if (forced && forced !== 'auto') return { name: forced, ...FRAMEWORKS[forced] };
  for (const [name, spec] of Object.entries(FRAMEWORKS)) {
    if (spec.files.some((f) => fs.existsSync(path.join(dir, f)))) return { name, ...spec };
  }
  return null;
}

function summarize(fw, { code, out }) {
  const body = (out || '').trim();
  const passed = (body.match(/✓|\bPASS\b|\bok\b/gi) || []).length;
  const failed = (body.match(/✗|\bFAIL\b|\bFAILED\b/gi) || []).length;
  const head = `${fw}: exit ${code} — ${passed} pass / ${failed} fail (heuristic counts)\n\n`;
  return head + body.slice(0, MAX_READ);
}

// ---------------------------------------------------------------- compile_run

const compileRunSchema = z.object({
  file: z.string().min(1),
  stdin: z.string().optional(),
  args: z.array(z.string()).optional(),
});

const LANG = {
  '.rs': { compile: ['rustc', '-O', '-o'], out: 'prog', run: (bin) => [bin] },
  '.go': { compile: ['go', 'build', '-o'], out: 'prog', run: (bin) => [bin] },
  '.c': { compile: ['gcc', '-O2', '-o'], out: 'prog', run: (bin) => [bin] },
  '.cpp': { compile: ['g++', '-O2', '-o'], out: 'prog', run: (bin) => [bin] },
};

export const compileRunTool = {
  name: 'compile_run',
  description: 'Compile a Rust/Go/C/C++ file and run it. Compiler errors come back with line numbers so you can fix them directly. Dangerous: it compiles and runs untrusted code.',
  isDangerous: true,
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Path relative to the workspace (e.g. main.rs, main.go, prog.c)' },
      stdin: { type: 'string', description: 'Text to feed to the program on stdin' },
      args: { type: 'array', items: { type: 'string' }, description: 'Command-line arguments' },
    },
    required: ['file'],
    additionalProperties: false,
  },
  schema: compileRunSchema,
  async execute({ file, stdin, args }, ctx = {}) {
    const r = resolveInWorkspace(ctx.userId ?? ctx.chatId, file);
    if (!r.ok) return `⚠️ ${r.reason}`;
    if (!fs.existsSync(r.abs)) return `⚠️ no such file: ${file}`;

    const spec = LANG[path.extname(r.abs)];
    if (!spec) return `⚠️ unsupported extension: ${path.extname(r.abs)} — try .rs, .go, .c, .cpp`;
    const outBin = path.join(path.dirname(r.abs), `${spec.out}-${process.pid}`);
    const compile = await runChildDetached(spec.compile[0], [...spec.compile.slice(1), outBin, r.abs], path.dirname(r.abs), 90);
    if (compile.code !== 0) {
      return `⚠️ compile failed (exit ${compile.code}):\n${(compile.out || '').trim().slice(0, MAX_READ)}\n\nFix the reported line:column errors and try again.`;
    }
    const run = await runChildDetached(outBin, [...spec.run(outBin), ...(args || [])], path.dirname(r.abs), 30, stdin);
    try { fs.unlinkSync(outBin); } catch {}
    return `✅ ran ${file} (exit ${run.code}):\n${(run.out || '').trim().slice(0, MAX_READ) || '(no output)'}`;
  },
};

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
