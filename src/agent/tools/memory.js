// language: JavaScript (Node 20+ ESM), file: src/agent/tools/memory.js
// Memory tools: long-term recall, lessons, decision journal, scratchpad.
//
// The context window forgets. The point of this layer is that what the agent
// learned about a user survives a /reset, a session switch, and a restart —
// without paying context tokens for it every turn. Facts are injected into the
// message array by memory.js (below the cached prefix); these tools are how the
// model writes and queries them.
//
// Scratchpad is the opposite problem: mid-turn working state (a list of URLs
// already scanned, a partial result) does not belong in context — it is
// write-heavy and read once. Store it, read it back, keep the window clean.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { logger } from '../../logger.js';
import { workspaceFor } from '../workspace.js';
import {
  remember, recall, forgetMemory, memoryStats,
  recordLesson, findLessons,
  recordDecision, recentDecisions,
} from '../store-kv.js';

// --------------------------------------------------------------- long-term memory

const rememberSchema = z.object({
  fact: z.string().min(3).max(2000),
  kind: z.enum(['fact', 'preference', 'project']).optional(),
  key: z.string().max(200).optional(),
});

export const rememberTool = {
  name: 'remember',
  description: 'Store a durable fact about the user or project that should survive past this conversation — a preference, a standing convention, a project detail. Use for things true tomorrow, not things true right now. Written as a declarative sentence.',
  isDangerous: false,
  parameters: {
    type: 'object',
    properties: {
      fact: { type: 'string', description: 'A declarative statement, e.g. "User prefers replies in Indonesian"' },
      kind: { type: 'string', enum: ['fact', 'preference', 'project'], description: 'What kind of fact (default: fact)' },
      key: { type: 'string', description: 'Optional short key to group or overwrite related facts (e.g. a project name)' },
    },
    required: ['fact'],
    additionalProperties: false,
  },
  schema: rememberSchema,
  async execute({ fact, kind, key }, ctx = {}) {
    const uid = String(ctx.userId ?? ctx.chatId ?? 0);
    remember(uid, kind || 'fact', fact, key || null, 1.0);
    logger.info({ uid, kind, len: fact.length }, 'lt memory stored');
    return `✅ remembered (${kind || 'fact'}): ${fact.slice(0, 120)}`;
  },
};

const recallToolSchema = z.object({
  kind: z.enum(['fact', 'preference', 'project']).optional(),
  limit: z.number().int().positive().max(50).optional(),
  query: z.string().max(500).optional(),
});

export const recallTool = {
  name: 'recall',
  description: 'Recall durable facts stored with remember. Returns the strongest matches. Read-only.',
  isDangerous: false,
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['fact', 'preference', 'project'], description: 'Scope to one kind' },
      limit: { type: 'number', description: 'Max results (default 10)' },
      query: { type: 'string', description: 'Rank results by relevance to this text' },
    },
    required: [],
    additionalProperties: false,
  },
  schema: recallToolSchema,
  async execute({ kind, limit, query }, ctx = {}) {
    const uid = String(ctx.userId ?? ctx.chatId ?? 0);
    const rows = recall(uid, { kind, limit: limit ?? 10 });
    if (!rows.length) return 'No long-term memories stored for this user yet.';
    // Rank by overlap with the query when one was given — a recall that
    // returns the oldest fact first is not a recall, it is a listing.
    if (query) {
      const want = new Set(query.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
      rows.sort((a, b) => score(b, want) - score(a, want));
    }
    return rows.map((r) => `[${r.kind}${r.key ? `: ${r.key}` : ''}] ${r.value}`).join('\n');
  },
};

function score(row, want) {
  if (!want.size) return row.confidence;
  const have = new Set(String(row.value).toLowerCase().split(/\W+/));
  let overlap = 0;
  for (const w of have) if (want.has(w)) overlap++;
  return row.confidence + overlap / want.size;
}

const forgetSchema = z.object({
  fact: z.string().min(3).max(2000).optional(),
  kind: z.enum(['fact', 'preference', 'project']).optional(),
});

export const forgetTool = {
  name: 'forget',
  description: 'Delete a stored memory — one fact by text, one kind, or everything for this user. Dangerous in the sense that it is irreversible.',
  isDangerous: true,
  parameters: {
    type: 'object',
    properties: {
      fact: { type: 'string', description: 'Exact fact text to remove (as returned by recall)' },
      kind: { type: 'string', enum: ['fact', 'preference', 'project'], description: 'Remove every fact of this kind' },
    },
    required: [],
    additionalProperties: false,
  },
  schema: forgetSchema,
  async execute({ fact, kind }, ctx = {}) {
    const uid = String(ctx.userId ?? ctx.chatId ?? 0);
    if (!fact && !kind) return '⚠️ give a fact to remove or a kind to clear.';
    const n = forgetMemory(uid, kind, fact);
    return n ? `✅ removed ${n} memor${n === 1 ? 'y' : 'ies'}` : '⚠️ nothing matched that.';
  },
};

// --------------------------------------------------------------- lessons

const lessonSchema = z.object({
  problem: z.string().min(10).max(2000),
  solution: z.string().min(3).max(2000),
  context: z.string().max(500).optional(),
});

export const lessonTool = {
  name: 'record_lesson',
  description: 'Store a failed approach and the fix that worked, so the same failure is not repeated. Use after a retry succeeds, or after the user corrects an approach.',
  isDangerous: false,
  parameters: {
    type: 'object',
    properties: {
      problem: { type: 'string', description: 'What went wrong or what was tried first' },
      solution: { type: 'string', description: 'What actually worked' },
      context: { type: 'string', description: 'Optional surrounding detail (file, tool, error class)' },
    },
    required: ['problem', 'solution'],
    additionalProperties: false,
  },
  schema: lessonSchema,
  async execute({ problem, solution, context }, ctx = {}) {
    const uid = String(ctx.userId ?? ctx.chatId ?? 0);
    recordLesson(uid, problem, solution, context || null);
    return `✅ lesson stored. It will surface when a similar problem appears.`;
  },
};

const lessonQuerySchema = z.object({ problem: z.string().min(5).max(2000) });

export const lessonQueryTool = {
  name: 'recall_lesson',
  description: 'Find whether a similar failure was solved before. Call this when a tool fails and before retrying blindly. Read-only.',
  isDangerous: false,
  parameters: {
    type: 'object',
    properties: { problem: { type: 'string', description: 'The current failure or situation' } },
    required: ['problem'],
    additionalProperties: false,
  },
  schema: lessonQuerySchema,
  async execute({ problem }, ctx = {}) {
    const uid = String(ctx.userId ?? ctx.chatId ?? 0);
    const hits = findLessons(uid, problem, 3);
    if (!hits.length) return 'No prior lesson matches this problem.';
    return hits.map((h, i) => `${i + 1}. Then: ${h.problem.slice(0, 150)}\n   Fix: ${h.solution.slice(0, 200)}`).join('\n\n');
  },
};

// --------------------------------------------------------------- decision journal

const decideSchema = z.object({
  chose: z.string().min(3).max(2000),
  rejected: z.string().max(2000).optional(),
  reason: z.string().min(3).max(2000),
});

export const decideTool = {
  name: 'record_decision',
  description: 'Log why you chose one path over another. Fills the decision journal the user can read with /why — a choice that looks arbitrary without it.',
  isDangerous: false,
  parameters: {
    type: 'object',
    properties: {
      chose: { type: 'string', description: 'The path taken' },
      rejected: { type: 'string', description: 'The alternative considered and skipped' },
      reason: { type: 'string', description: 'Why — the constraint, cost, or risk that decided it' },
    },
    required: ['chose', 'reason'],
    additionalProperties: false,
  },
  schema: decideSchema,
  async execute({ chose, rejected, reason }, ctx = {}) {
    const uid = String(ctx.userId ?? ctx.chatId ?? 0);
    recordDecision(uid, chose, reason, rejected || null, null);
    return `✅ decision logged: ${chose.slice(0, 100)} — ${reason.slice(0, 100)}`;
  },
};

// --------------------------------------------------------------- scratchpad

const scratchDir = 'scratch';
function scratchPath(userId, key) {
  const dir = path.join(workspaceFor(userId), scratchDir);
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(key).replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 120) || 'note';
  return path.join(dir, `${safe}.json`);
}

const scratchWriteSchema = z.object({
  key: z.string().min(1).max(120),
  value: z.string().max(500_000),
  append: z.boolean().optional(),
});

export const scratchWriteTool = {
  name: 'scratch_write',
  description: 'Save working state to a per-user scratch file — a list of URLs scanned, a partial result, a plan in progress. Keeps it out of the context window. Cheap to write, read once.',
  isDangerous: false,
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'A name for this note (e.g. "scanned-urls")' },
      value: { type: 'string', description: 'The content to store' },
      append: { type: 'boolean', description: 'Append to an existing note instead of overwriting (default false)' },
    },
    required: ['key', 'value'],
    additionalProperties: false,
  },
  schema: scratchWriteSchema,
  async execute({ key, value, append }, ctx = {}) {
    const uid = ctx.userId ?? ctx.chatId ?? 0;
    const p = scratchPath(uid, key);
    if (append && fs.existsSync(p)) {
      const prev = fs.readFileSync(p, 'utf8');
      // Append as a new line, not concatenated JSON — these are notes, not records
      fs.writeFileSync(p, `${prev.trimEnd()}\n${value}`);
      return `✅ appended to ${key} (${value.length} chars)`;
    }
    fs.writeFileSync(p, value);
    return `✅ saved ${key} (${value.length} chars)`;
  },
};

const scratchReadSchema = z.object({
  key: z.string().min(1).max(120),
});

export const scratchReadTool = {
  name: 'scratch_read',
  description: 'Read back a scratch note saved with scratch_write. Read-only.',
  isDangerous: false,
  parameters: {
    type: 'object',
    properties: { key: { type: 'string', description: 'The note name' } },
    required: ['key'],
    additionalProperties: false,
  },
  schema: scratchReadSchema,
  async execute({ key }, ctx = {}) {
    const uid = ctx.userId ?? ctx.chatId ?? 0;
    const p = scratchPath(uid, key);
    if (!fs.existsSync(p)) return `⚠️ no scratch note named "${key}".`;
    return fs.readFileSync(p, 'utf8').slice(0, 64 * 1024);
  },
};

export const memoryTools = [
  rememberTool, recallTool, forgetTool,
  lessonTool, lessonQueryTool,
  decideTool,
];
