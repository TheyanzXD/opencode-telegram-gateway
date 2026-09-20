// language: JavaScript (Node 20+ ESM), file: src/agent/tools/observability.js
// Observability tools the model can call:
//   trace_export  — the structured trace of a run (its own, or the last one)
//   cost_report   — per-turn cost and timing attribution over a window
//   scratchpad_*  — per-user working state that stays out of the context window
//
// All three are read-only with one exception: scratchpad_write/delete mutate
// the agent's own scratch table. Neither touches the host filesystem or the
// network, so none is approval-gated. Cost data is scoped to the caller's own
// user id; an operator (config.telegram.admins) may query another user.
//
// Every tool returns a string and never throws — the registry contract.

import { z } from 'zod';
import { isAdmin } from '../../config.js';
import { logger } from '../../logger.js';
import {
  exportOne, exportMany, isFormat, TRACE_FORMATS,
} from '../observability/export.js';
import { spendSummary, recentTurns } from '../observability/store.js';
import { pricingCatalog, priceFor } from '../observability/pricing.js';
import {
  scratchWrite, scratchRead, scratchList, scratchDelete, scratchHistory,
} from '../observability/store.js';

const MAX_EXPORT_CHARS = 60_000; // a trace export is capped before it re-enters context
const PREVIEW = 120;

// ---------------------------------------------------------------- trace_export

const traceExportSchema = z.object({
  trace_id: z.string().max(200).optional(),
  format: z.enum(TRACE_FORMATS).optional(),
  pretty: z.boolean().optional(),
  limit: z.number().int().positive().max(50).optional(),
});

function uidOf(ctx, override) {
  const own = String(ctx.userId ?? ctx.chatId ?? 0);
  if (override == null || String(override) === own) return { userId: own, ok: true };
  // A user can only read their own traces; an operator can read anyone's.
  if (!isAdmin(own)) return { userId: own, ok: false };
  return { userId: String(override), ok: true };
}

export const traceExportTool = {
  name: 'trace_export',
  description: 'Export the structured trace of an agent run — every provider call with its tokens, latency, and cost, and every tool call with its share of the bill. Defaults to the most recent run in this chat. Read-only.',
  isDangerous: false,
  parameters: {
    type: 'object',
    properties: {
      trace_id: { type: 'string', description: 'A specific trace id (from cost_report or /debug). Omit for the most recent run.' },
      format: { type: 'string', enum: TRACE_FORMATS, description: 'json (default), ndjson, otel (OpenTelemetry-shaped spans), markdown, text' },
      pretty: { type: 'boolean', description: 'Indent JSON (default true)' },
      limit: { type: 'number', description: 'When omitting trace_id: how many recent runs to export (default 1, max 50)' },
    },
    required: [],
    additionalProperties: false,
  },
  schema: traceExportSchema,
  async execute(args, ctx = {}) {
    const fmt = args.format || 'json';
    if (!isFormat(fmt)) return `⚠️ unknown format "${fmt}". Use one of: ${TRACE_FORMATS.join(', ')}.`;

    // A specific trace is the caller's unless they are an operator.
    if (args.trace_id) {
      const { userId, ok } = uidOf(ctx, args.user_id);
      if (!ok) return '⚠️ you can only export your own traces.';
      const body = exportOne(args.trace_id, fmt, { pretty: args.pretty });
      if (body === null) return `⚠️ no trace found with id "${args.trace_id}".`;
      return cap(body);
    }

    // No id → the most recent runs for this user.
    const { userId, ok } = uidOf(ctx, args.user_id);
    if (!ok) return '⚠️ you can only export your own traces.';
    const limit = args.limit ?? 1;
    const body = exportMany({ userId, limit }, fmt);
    if (!body) return `No agent runs recorded for this user yet. Run a task first, then export it.`;
    return cap(body);
  },
};

// ---------------------------------------------------------------- cost_report

const costReportSchema = z.object({
  window: z.string().max(20).optional(),
  user_id: z.union([z.string(), z.number()]).optional(),
  breakdown: z.enum(['model', 'tool', 'none']).optional(),
});

const WINDOWS = {
  '1h': 3600_000, hour: 3600_000, today: 'today',
  '24h': 86400_000, day: 86400_000, daily: 86400_000,
  '7d': 7 * 86400_000, week: 7 * 86400_000,
  '30d': 30 * 86400_000, month: 30 * 86400_000,
  all: null, '': null,
};

function windowMs(w) {
  const key = String(w || '').trim().toLowerCase();
  if (!(key in WINDOWS)) return null;
  const v = WINDOWS[key];
  if (v === 'today') {
    const d = new Date();
    return Date.now() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  return v; // null = no lower bound
}

// "all" is a valid window; it is stored as null (no lower bound), so the
// presence check must use the key set, not the resolved value.
function windowExists(w) {
  return String(w || '').trim().toLowerCase() in WINDOWS;
}

export const costReportTool = {
  name: 'cost_report',
  description: 'Report spending and latency over a window: total USD, tokens, per-turn average, p50/p95 duration, error rate, and a per-model or per-tool breakdown. Unpriced models are listed, never guessed. Read-only.',
  isDangerous: false,
  parameters: {
    type: 'object',
    properties: {
      window: { type: 'string', description: '1h | today | 24h | 7d | 30d | all (default 24h)' },
      user_id: { type: ['string', 'number'], description: 'Another user (operators only; default: you)' },
      breakdown: { type: 'string', enum: ['model', 'tool', 'none'], description: 'Which breakdown table to include (default: model)' },
    },
    required: [],
    additionalProperties: false,
  },
  schema: costReportSchema,
  async execute(args, ctx = {}) {
    if (!windowExists(args.window)) return `⚠️ unknown window "${args.window}". Try: 1h, today, 24h, 7d, 30d, or all.`;
    const w = windowMs(args.window);

    const { userId, ok } = uidOf(ctx, args.user_id);
    if (!ok) return '⚠️ you can only read your own cost report.';

    const s = spendSummary({ userId, sinceMs: w });
    if (!s.turns) return `No agent turns in this window${args.window ? ` (${args.window})` : ''} yet.`;

    const lines = [
      `Cost report — ${args.window || '24h'}${s.window.userId ? ` user ${s.window.userId}` : ''}`,
      `turns ${s.turns}  calls ${s.calls}  errors ${(s.errorRate * 100).toFixed(0)}%`,
      `spend $${s.totalUsd.toFixed(6)}  avg $${s.avgPerTurnUsd.toFixed(6)}/turn`,
      `tokens ${fmtInt(s.totalTokens)} (${fmtInt(s.promptTokens)} in / ${fmtInt(s.completionTokens)} out` +
        (s.cachedTokens ? `, ${fmtInt(s.cachedTokens)} cached` : '') +
        (s.reasoningTokens ? `, ${fmtInt(s.reasoningTokens)} reasoning` : '') + ')',
      `latency p50 ${fmtMs(s.p50Ms)}  p95 ${fmtMs(s.p95Ms)}  avg ${fmtMs(s.avgTurnMs)}`,
    ];
    if (s.unpricedCalls) {
      const models = s.byModel.filter((m) => !m.pricedCalls).map((m) => m.model);
      lines.push(`⚠️ ${s.unpricedCalls} call${s.unpricedCalls === 1 ? '' : 's'} unpriced: ${models.join(', ') || '(unknown model)'} — rates unknown, not zero.`);
    }

    const brk = args.breakdown || 'model';
    if (brk === 'model' && s.byModel.length) {
      lines.push('', 'by model:');
      for (const m of s.byModel.slice(0, 8)) {
        lines.push(`  ${m.model}  ${m.calls} calls  $${m.usd.toFixed(6)}  ${fmtInt(m.tokens)} tok  ${fmtMs(m.avgMs)} avg${m.errors ? `  ${m.errors} fail` : ''}`);
      }
    } else if (brk === 'tool' && s.byTool.length) {
      lines.push('', 'by tool:');
      for (const t of s.byTool.slice(0, 12)) {
        lines.push(`  ${t.tool}  ${t.calls} calls  ${fmtMs(t.avgMs)} avg  ${fmtBytes(t.avgBytes)} avg${t.usd ? `  $${t.usd.toFixed(6)}` : ''}${t.errors ? `  ${t.errors} fail` : ''}`);
      }
    }
    return lines.join('\n');
  },
};

// ---------------------------------------------------------------- scratchpad

const scratchWriteSchema = z.object({
  key: z.string().min(1).max(120),
  // optional() keeps the parameter schema's shape (value is documented), but
  // execute() rejects an absent value with a tool message instead of a
  // zod error — a missing payload is a caller mistake, not a schema violation.
  value: z.union([z.string().max(500_000), z.any()]).optional(),
  append: z.boolean().optional(),
});

/** Turn any stored value back into something the model can read inline. */
function decodeScratch(raw) {
  if (raw == null) return null;
  const s = String(raw.value);
  // Stored JSON is re-stringified; plain text is returned as-is.
  if (s.startsWith('{') || s.startsWith('[')) {
    try { return JSON.stringify(JSON.parse(s), null, 2); } catch { /* not json */ }
  }
  return s;
}

export const scratchpadWriteTool = {
  name: 'scratchpad_write',
  description: 'Store working state for this task in a per-user scratch doc — URLs already scanned, a partial result, a plan in progress, a tally. Keeps it out of the context window: write many times, read once. Revision history is kept automatically.',
  isDangerous: false,
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'A name for this note (e.g. "scanned-urls")' },
      value: { type: 'string', description: 'The content to store (an object is stored as JSON)' },
      append: { type: 'boolean', description: 'Append to the current value instead of replacing it (default false)' },
    },
    required: ['key'],
    additionalProperties: false,
  },
  schema: scratchWriteSchema,
  async execute({ key, value, append }, ctx = {}) {
    const uid = ctx.userId ?? ctx.chatId ?? 0;
    const k = String(key || '').trim();
    if (value === undefined || value === null) return '⚠️ nothing to store — give a value.';
    let body = typeof value === 'string' ? value : JSON.stringify(value);

    if (append) {
      const prev = scratchRead(uid, k);
      if (prev) {
        // Join with a newline; appended JSON arrays would not re-parse, so an
        // append onto a structured value keeps both as text.
        body = `${String(prev.value).trimEnd()}\n${body}`;
      }
    }
    const rec = scratchWrite(uid, k, body);
    return `✅ ${append ? 'appended to' : 'saved'} ${k} — ${fmtBytes(rec.bytes)}, revision ${rec.revision}`;
  },
};

export const scratchpadReadTool = {
  name: 'scratchpad_read',
  description: 'Read back a scratch note saved with scratchpad_write. Use it to resume a task after the context window has moved on. Read-only.',
  isDangerous: false,
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'The note name' },
      history: { type: 'boolean', description: 'Return the revision history instead of the current value (default false)' },
      revision: { type: 'number', description: 'Read one specific older revision (implies history layout)' },
    },
    required: ['key'],
    additionalProperties: false,
  },
  schema: z.object({
    key: z.string().min(1).max(120),
    history: z.boolean().optional(),
    revision: z.number().int().positive().max(10_000).optional(),
  }),
  async execute({ key, history, revision }, ctx = {}) {
    const uid = ctx.userId ?? ctx.chatId ?? 0;
    const k = String(key || '').trim();

    if (history || revision) {
      const rows = scratchHistory(uid, k, revision ? 100 : 10);
      if (!rows.length) return `⚠️ no history for scratch note "${k}".`;
      const want = revision ? rows.filter((r) => r.revision === revision) : rows;
      const body = want.map((r) => `--- revision ${r.revision}  ${fmtBytes(r.bytes)}  ${stamp(r.written_at)}\n${String(r.value)}`);
      return cap(`${body.join('\n\n')}`);
    }

    const rec = scratchRead(uid, k);
    if (!rec) return `⚠️ no scratch note named "${k}".`;
    const body = decodeScratch(rec);
    return `revision ${rec.revision}  ${fmtBytes(rec.bytes)}  ${stamp(rec.updated_at)}\n${cap(body, MAX_EXPORT_CHARS)}`;
  },
};

export const scratchpadListTool = {
  name: 'scratchpad_list',
  description: 'List this user\'s scratch notes with size and revision. Read-only.',
  isDangerous: false,
  parameters: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  schema: z.object({}),
  async execute(_args, ctx = {}) {
    const uid = ctx.userId ?? ctx.chatId ?? 0;
    const rows = scratchList(uid);
    if (!rows.length) return 'No scratch notes yet. Use scratchpad_write to store working state.';
    return rows.map((r) => `${r.key}  ${fmtBytes(r.bytes)}  rev ${r.revision}`).join('\n');
  },
};

export const scratchpadDeleteTool = {
  name: 'scratchpad_delete',
  description: 'Delete a scratch note. Its revision history is kept, so nothing is unrecoverable. Use it to clear stale working state.',
  isDangerous: false,
  parameters: {
    type: 'object',
    properties: { key: { type: 'string', description: 'The note name' } },
    required: ['key'],
    additionalProperties: false,
  },
  schema: z.object({ key: z.string().min(1).max(120) }),
  async execute({ key }, ctx = {}) {
    const uid = ctx.userId ?? ctx.chatId ?? 0;
    const ok = scratchDelete(uid, String(key || '').trim());
    return ok ? `✅ deleted "${key}" (history kept — scratchpad_read with history:true)` : `⚠️ no scratch note named "${key}".`;
  },
};

// ---------------------------------------------------------------- shared

function fmtInt(n) {
  return new Intl.NumberFormat('en-US').format(Number(n) || 0);
}
function fmtMs(ms) {
  const n = Number(ms) || 0;
  return n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(2)}s`;
}
function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v}B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)}KB`;
  return `${(v / (1024 * 1024)).toFixed(2)}MB`;
}
function cap(s, n = MAX_EXPORT_CHARS) {
  const v = String(s ?? '');
  return v.length > n ? `${v.slice(0, n)}\n…[truncated, ${v.length - n} more chars]` : v;
}
/** A zero epoch is "never written", not 1970 — an unconfigured clock is not a date. */
function stamp(ms) {
  const n = Number(ms) || 0;
  if (!n) return 'no timestamp';
  try { return `updated ${new Date(n).toISOString()}`; } catch { return 'no timestamp'; }
}

export const observabilityTools = [
  traceExportTool,
  costReportTool,
  scratchpadWriteTool,
  scratchpadReadTool,
  scratchpadListTool,
  scratchpadDeleteTool,
];
