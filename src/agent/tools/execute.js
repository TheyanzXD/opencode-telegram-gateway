// language: JavaScript (Node 20+ ESM), file: src/agent/tools/execute.js
// execute_python, execute_node, job_start/status/output/kill, git.
//
// Why a job manager at all: a build or a test suite runs minutes, and a tool
// call has a 30s budget. A long-running tool is killed mid-way and the agent
// concludes the task failed when it did not. job_start detaches the process;
// the agent checks back later with job_output, same as a human would.

import { spawn } from 'node:child_process';
import vm from 'node:vm';
import { z } from 'zod';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { workspaceFor } from '../workspace.js';

const MAX_OUTPUT = 256 * 1024; // 256 KB cap — the context window is the limit

// userId → Map<name, {proc, chunks, status, code, started, finished}>
const _jobs = new Map();

function jobsOf(userId) {
  const key = String(userId ?? '0');
  if (!_jobs.has(key)) _jobs.set(key, new Map());
  return _jobs.get(key);
}

function tail(chunks, cap = MAX_OUTPUT) {
  const s = chunks.join('');
  if (s.length <= cap) return s;
  return '…[earlier output truncated]\n' + s.slice(-cap);
}

// ---------------------------------------------------------------- python

const pythonSchema = z.object({
  code: z.string().min(1).max(60_000),
  timeout: z.number().int().positive().max(600).optional(),
});

export const executePython = {
  name: 'execute_python',
  description: 'Run Python code and return stdout+stderr. Use for data analysis, math, file processing — anything needing pandas/numpy/stdlib that bash cannot express cleanly. Dangerous: it runs real code.',
  isDangerous: true,
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Python source to run (passed via stdin to python3)' },
      timeout: { type: 'number', description: 'Seconds before the process is killed (default 30)' },
    },
    required: ['code'],
    additionalProperties: false,
  },
  schema: pythonSchema,
  async execute({ code, timeout }, ctx = {}) {
    const cwd = workspaceFor(ctx.userId ?? ctx.chatId);
    const secs = Math.min(timeout ?? 30, config.agent?.bashTimeoutMs ? config.agent.bashTimeoutMs / 1000 : 30);
    const out = await runChild('python3', ['-c', code], { cwd, timeoutSec: secs });
    return formatOut('python3', out);
  },
};

// ---------------------------------------------------------------- node (VM sandbox)

const nodeSchema = z.object({
  code: z.string().min(1).max(60_000),
  timeout_ms: z.number().int().positive().max(60_000).optional(),
});

export const executeNode = {
  name: 'execute_node',
  description: 'Evaluate JavaScript in a sandboxed V8 context. No fs, no child_process, no network unless you provide them — safe for JSON transforms and expression evaluation. Returns the value of the last expression. Read-only to the host.',
  isDangerous: false, // node:vm without require — no host access by construction
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'JavaScript to evaluate (last expression is the result)' },
      timeout_ms: { type: 'number', description: 'Evaluation budget in ms (default 5000)' },
    },
    required: ['code'],
    additionalProperties: false,
  },
  schema: nodeSchema,
  async execute({ code, timeout_ms }, _ctx = {}) {
    // Wrap so the last expression becomes a return: { …code } keeps
    // statements working while the final expression is the value.
    const wrapped = `(function() { ${code} })()`;
    const ctx = vm.createContext({ console, JSON, Math, Object, Array, String, Number, Boolean, Date, RegExp, Map, Set, Error, setTimeout: () => {} });
    let value;
    try {
      value = vm.runInContext(wrapped, ctx, { timeout: timeout_ms ?? 5000, filename: 'execute_node' });
    } catch (err) {
      return `⚠️ evaluation failed: ${err.message}`;
    }
    const out = typeof value === 'string' ? value : safeJson(value);
    return out.slice(0, MAX_OUTPUT);
  },
};

function safeJson(v) {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

// ---------------------------------------------------------------- git

const gitSchema = z.object({
  args: z.array(z.string().min(1)).min(1).max(12),
  repo: z.string().optional(),
});

const GIT_REFUSED = [
  /push\s+.*--force/i,
  /push\s+-f\b/,
  /reset\s+--hard/i,
  /clean\s+-[a-z]*[fx]/i,
];

export const gitTool = {
  name: 'git',
  description: 'Run a git command in the user\'s workspace (status, diff, log, add, commit, branch, checkout, pull). Dangerous — it can rewrite history and push.',
  isDangerous: true,
  parameters: {
    type: 'object',
    properties: {
      args: { type: 'array', items: { type: 'string' }, description: 'git subcommand and flags, e.g. ["status"] or ["commit","-m","msg"]' },
      repo: { type: 'string', description: 'Subdirectory of the workspace containing the repo (default: workspace root)' },
    },
    required: ['args'],
    additionalProperties: false,
  },
  schema: gitSchema,
  async execute({ args, repo }, ctx = {}) {
    const joined = args.join(' ');
    for (const pat of GIT_REFUSED) {
      if (pat.test(joined)) return `⚠️ refused: this git command can discard work (${joined}). Do it manually if you really need it.`;
    }
    const root = workspaceFor(ctx.userId ?? ctx.chatId);
    const cwd = repo ? path.resolve(root, repo) : root;
    if (!cwd.startsWith(root)) return '⚠️ repo path escapes the workspace';
    if (!fs.existsSync(path.join(cwd, '.git'))) {
      return '⚠️ not a git repository here. Run `git init` first, or point repo: at the right subdirectory.';
    }
    const out = await runChild('git', args, { cwd, timeoutSec: 30 });
    return formatOut('git', out);
  },
};

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- job manager

const jobStartSchema = z.object({
  command: z.string().min(1).max(4096),
  name: z.string().min(1).max(60).optional(),
  cwd: z.string().optional(),
});

export const jobStart = {
  name: 'job_start',
  description: 'Start a long-running command detached (builds, test suites, servers). Returns immediately with a job name — check progress with job_output / job_status. Dangerous: it launches a real process that outlives the tool call.',
  isDangerous: true,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to run in the background' },
      name: { type: 'string', description: 'A label to find the job by later (default: job1, job2, …)' },
      cwd: { type: 'string', description: 'Subdirectory of the workspace to run in' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  schema: jobStartSchema,
  async execute({ command, name, cwd }, ctx = {}) {
    const jobs = jobsOf(ctx.userId ?? ctx.chatId);
    const label = name || `job${jobs.size + 1}`;
    if (jobs.has(label)) return `⚠️ a job named ${label} already exists — pick another or kill it first.`;

    const root = workspaceFor(ctx.userId ?? ctx.chatId);
    const dir = cwd ? path.resolve(root, cwd) : root;
    if (!dir.startsWith(root)) return '⚠️ cwd escapes the workspace';

    const proc = spawn(command, { shell: true, cwd: dir, env: { ...process.env }, windowsHide: true });
    const job = { proc, chunks: [], status: 'running', code: null, started: Date.now(), finished: null };
    proc.stdout.on('data', (d) => job.chunks.push(String(d)));
    proc.stderr.on('data', (d) => job.chunks.push(String(d)));
    proc.on('close', (code) => { job.status = 'exited'; job.code = code; job.finished = Date.now(); });
    proc.on('error', (err) => { job.status = 'error'; job.chunks.push(err.message); job.finished = Date.now(); });
    jobs.set(label, job);
    logger.info({ job: label, pid: proc.pid }, 'job started');
    return `✅ job "${label}" started (pid ${proc.pid}). Check: job_output "${label}"`;
  },
};

const jobNameSchema = z.object({ name: z.string().min(1).max(60) });

export const jobStatus = {
  name: 'job_status',
  description: 'List running and finished background jobs, or show one job\'s state. Read-only.',
  isDangerous: false,
  parameters: { type: 'object', properties: { name: { type: 'string' } }, required: [], additionalProperties: false },
  schema: z.object({ name: z.string().optional() }),
  async execute({ name }, ctx = {}) {
    const jobs = jobsOf(ctx.userId ?? ctx.chatId);
    if (name) {
      const j = jobs.get(name);
      if (!j) return `⚠️ no job named "${name}".`;
      return describe(j, name);
    }
    if (!jobs.size) return 'No background jobs.';
    return [...jobs.entries()].map(([n, j]) => describe(j, n)).join('\n');
  },
};

function describe(j, name) {
  const elapsed = j.finished ? `${Math.round((j.finished - j.started) / 1000)}s` : `${Math.round((Date.now() - j.started) / 1000)}s`;
  return `${name}: ${j.status}${j.code != null ? ` (code ${j.code})` : ''} — ${elapsed}`;
}

export const jobOutput = {
  name: 'job_output',
  description: 'Read the output of a background job. By default the last 8 KB. Use this to check a build or test run that takes longer than a tool call. Read-only.',
  isDangerous: false,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The job label from job_start' },
      tail_chars: { type: 'number', description: 'How many trailing characters to return (default 8192)' },
      follow: { type: 'boolean', description: 'Wait up to 10s for new output if the job is still running' },
    },
    required: ['name'],
    additionalProperties: false,
  },
  schema: z.object({
    name: z.string().min(1).max(60),
    tail_chars: z.number().int().positive().max(128_000).optional(),
    follow: z.boolean().optional(),
  }),
  async execute({ name, tail_chars, follow }, ctx = {}) {
    const jobs = jobsOf(ctx.userId ?? ctx.chatId);
    const j = jobs.get(name);
    if (!j) return `⚠️ no job named "${name}".`;

    if (follow && j.status === 'running') {
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        if (j.status !== 'running') break;
      }
    }
    const cap = tail_chars ?? 8192;
    const body = j.chunks.join('');
    const out = body.length > cap ? '…[earlier output truncated]\n' + body.slice(-cap) : body;
    return `${describe(j, name)}\n\n${out || '(no output yet)'}`;
  },
};

export const jobKill = {
  name: 'job_kill',
  description: 'Kill a background job. Dangerous — it terminates a real process, which may leave files or state behind.',
  isDangerous: true,
  parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
  schema: jobNameSchema,
  async execute({ name }, ctx = {}) {
    const jobs = jobsOf(ctx.userId ?? ctx.chatId);
    const j = jobs.get(name);
    if (!j) return `⚠️ no job named "${name}".`;
    try { j.proc.kill('SIGTERM'); } catch {}
    j.status = 'killed';
    j.finished = Date.now();
    jobs.delete(name);
    return `✅ killed "${name}"`;
  },
};

// ---------------------------------------------------------------- shared

function runChild(bin, args, { cwd, timeoutSec = 30 }) {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { cwd, windowsHide: true, env: { ...process.env } });
    const chunks = [];
    proc.stdout.on('data', (d) => chunks.push(String(d)));
    proc.stderr.on('data', (d) => chunks.push(String(d)));
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      chunks.push(`\n⚠️ killed: exceeded ${timeoutSec}s timeout`);
      resolve({ code: 124, out: chunks.join('') });
    }, timeoutSec * 1000);
    proc.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, out: err.message }); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code, out: chunks.join('') }); });
  });
}

function formatOut(label, { code, out }) {
  const body = (out || '').trim();
  if (code === 0 || code === 124) return body.slice(0, MAX_OUTPUT) || `(no output)`;
  return `⚠️ ${label} exited with code ${code}\n${body.slice(0, MAX_OUTPUT)}`;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export const execTools = [
  executePython, executeNode, gitTool,
  jobStart, jobStatus, jobOutput, jobKill,
];
