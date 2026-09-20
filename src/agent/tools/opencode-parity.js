// language: JavaScript (Node 20+ ESM), file: src/agent/tools/opencode-parity.js
// The four tools the official opencode CLI ships that this bot had no
// equivalent for: grep, glob, todowrite, todoread.
//
// The rest of opencode's built-in set is already covered:
//   bash -> execute_bash        edit/multiedit -> edit_file, multi_edit
//   read -> read_file           write -> write_file
//   apply_patch -> diff_review  task -> delegate_task
//   skill -> the skills layer (src/agent/skills.js)
//   lsp (experimental) -> deliberately not ported: it needs a long-lived
//   language server per project directory, which a multi-user Telegram bot
//   cannot keep alive per user. AST-level editing covers the common cases.

import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { z } from 'zod';
import { workspaceFor } from '../workspace.js';
import { writeTodos, readTodos } from '../store-kv.js';
import { logger } from '../../logger.js';

const MAX_MATCH_BYTES = 60_000;
const MAX_GLOB_RESULTS = 200;

// ripgrep when present, a JS fallback when not. The fallback keeps the bot
// working on a bare deploy that skipped the rust toolchain.
function rgAvailable() {
  try {
    return spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

function runRg(root, pattern, fileGlob, limit) {
  return new Promise((resolve) => {
    const args = [
      '--color=never', '--line-number', '--no-heading', '--smart-case',
      '--max-count', String(Math.ceil(limit * 1.5)),
      ...(fileGlob ? ['--glob', fileGlob] : []),
      pattern,
      root,
    ];
    // --max-count is per file; the overall cap is enforced in JS.
    const out = spawn('rg', args, { maxBuffer: 4 * 1024 * 1024 });
    let raw = '';
    out.stdout.on('data', (d) => { raw += d.toString(); });
    out.on('error', () => resolve(null));
    out.on('close', () => resolve(raw));
  });
}

async function jsGrep(root, pattern, fileGlob, limit) {
  const { promisify } = await import('node:util');
  const files = await walk(root, fileGlob, MAX_MATCH_BYTES * 4);
  const re = new RegExp(pattern, 'i');
  const results = [];
  for (const file of files) {
    if (results.length >= limit) break;
    try {
      const text = await fs.readFile(file, 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= limit) break;
        if (re.test(lines[i])) {
          results.push(`${path.relative(root, file)}:${i + 1}:${lines[i].slice(0, 400)}`);
        }
      }
    } catch { /* unreadable or binary — skip */ }
  }
  return results.join('\n');
}

async function walk(root, fileGlob, byteBudget) {
  const { globby } = await import('globby').catch(() => ({ globby: null }));
  if (globby && fileGlob) return globby(path.join(root, fileGlob));
  // Minimal recursive walk when globby is unavailable. Skips the heavy
  // directories the search layer does not want anyway.
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'vendor', '.cache']);
  const out = [];
  let bytes = 0;
  async function recurse(dir) {
    if (out.length > 5_000 || bytes > byteBudget) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await recurse(full); continue; }
      if (!e.isFile()) continue;
      if (fileGlob && !matchGlob(fileGlob, e.name)) continue;
      out.push(full);
      bytes += 40;
      if (out.length > 5_000 || bytes > byteBudget) return;
    }
  }
  await recurse(root);
  return out;
}

// A single-pattern glob matcher, used only when globby is absent.
function matchGlob(pattern, name) {
  const body = pattern.replace(/^\.\//, '').split('/').pop();
  const re = new RegExp(
    '^' + body.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
  );
  return re.test(name);
}

const grepSchema = z.object({
  pattern: z.string().min(1).describe('Regular expression'),
  glob: z.string().optional().describe('File pattern, e.g. **/*.js or *.md'),
  limit: z.number().int().positive().max(500).optional().describe('Cap on matches (default 100)'),
  show_content: z.boolean().optional().describe('Include matching line text (default true)'),
});

const globSchema = z.object({
  pattern: z.string().min(1).describe('Glob pattern, e.g. **/*.js, src/**/*.test.mjs'),
  limit: z.number().int().positive().max(1000).optional().describe('Cap on results (default 200)'),
});

const todoSchema = z.object({
  todos: z.array(z.object({
    content: z.string().min(1),
    status: z.enum(['pending', 'in_progress', 'completed']),
    activeForm: z.string().optional(),
  })).min(1),
});

export const parityTools = [
  {
    name: 'grep',
    description:
      'Search file contents by regular expression across the workspace. Returns path:line:match. Use before reading files you have not seen.',
    isDangerous: false,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression' },
        glob: { type: 'string', description: 'File pattern, e.g. **/*.js or *.md' },
        limit: { type: 'number', description: 'Cap on matches (default 100)' },
        show_content: { type: 'boolean', description: 'Include matching line text (default true)' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    schema: grepSchema,
    async execute({ pattern, glob, limit = 100, show_content = true }, ctx = {}) {
      const root = workspaceFor(ctx.userId ?? ctx.chatId);
      let raw = null;
      if (rgAvailable()) raw = await runRg(root, pattern, glob, limit);
      if (!raw) raw = await jsGrep(root, pattern, glob, limit);
      if (!raw) return '⚠️ nothing matched (or search failed)';
      let lines = raw.split('\n').filter(Boolean).slice(0, limit);
      if (!show_content) lines = lines.map((l) => l.split(':').slice(0, 2).join(':'));
      const body = lines.join('\n');
      const shown = body.length > MAX_MATCH_BYTES ? body.slice(0, MAX_MATCH_BYTES) + `\n\n…[truncated, ${lines.length} more results]` : body;
      return `${lines.length} match${lines.length === 1 ? '' : 'es'}:\n\n${shown}`;
    },
  },

  {
    name: 'glob',
    description:
      'Find files by name pattern. Returns paths relative to the workspace root, newest first.',
    isDangerous: false,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. **/*.js, src/**/*.test.mjs' },
        limit: { type: 'number', description: 'Cap on results (default 200)' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    schema: globSchema,
    async execute({ pattern, limit = MAX_GLOB_RESULTS }, ctx = {}) {
      const root = workspaceFor(ctx.userId ?? ctx.chatId);
      const files = await walk(root, pattern, MAX_MATCH_BYTES);
      let sorted = files;
      try {
        const statted = await Promise.all(
          files.slice(0, 2000).map(async (f) => {
            try { const s = await fs.stat(f); return [f, s.mtimeMs]; }
            catch { return [f, 0]; }
          })
        );
        sorted = statted.sort((a, b) => b[1] - a[1]).map((r) => r[0]);
      } catch { /* stat failure leaves the unsorted list, which is still correct */ }
      const cut = sorted.slice(0, limit);
      return cut.map((f) => path.relative(root, f)).join('\n')
        + (sorted.length > cut.length ? `\n\n…[${sorted.length - cut.length} more]` : '');
    },
  },

  {
    name: 'todowrite',
    description:
      'Create or replace the task list for this session. The full list is written each call — statuses of every task, not just changed ones. Use before multi-step work.',
    isDangerous: false,
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'Every task, with its status. Sent in full each call.',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              activeForm: { type: 'string' },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
      additionalProperties: false,
    },
    schema: todoSchema,
    async execute({ todos }, ctx = {}) {
      const userId = String(ctx.userId ?? ctx.chatId ?? '0');
      writeTodos(userId, todos);
      return todos.map((t, i) => {
        const mark = t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' ';
        return `[${mark}] ${t.activeForm || t.content}`;
      }).join('\n');
    },
  },

  {
    name: 'todoread',
    description:
      'Read the current task list. Returns pending and in-progress tasks; empty when none are tracked.',
    isDangerous: false,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    schema: z.object({}),
    async execute(_args, ctx = {}) {
      const userId = String(ctx.userId ?? ctx.chatId ?? '0');
      const todos = readTodos(userId) || [];
      if (!todos.length) return 'no tasks tracked for this session';
      return todos.map((t) => {
        const mark = t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' ';
        return `[${mark}] ${t.content}`;
      }).join('\n');
    },
  },
];
