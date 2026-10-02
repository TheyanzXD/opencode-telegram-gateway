// language: JavaScript (Node 20+ ESM), file: src/agent/observability/export.js
// Structured trace export. One entry point per format; each is a thin wrapper
// over exportTrace() so the attribution logic lives in exactly one place.
//
// The JSON forms are consumed by machines — a dashboard, a spreadsheet, a
// billing reconciliation. The text forms are consumed by a human in Telegram,
// where 4096 chars is the wall and `_inside_words` breaks Markdown. The
// Markdown-safe renderer escapes the characters that actually split there and
// keeps the output fenced so a model's own output cannot break the fence.

import { logger } from '../../logger.js';
import { exportTrace } from './collector.js';
import { recentTurns } from './store.js';

export const TRACE_FORMATS = ['json', 'ndjson', 'otel', 'markdown', 'text'];

/** Validate a requested format before doing any work. */
export function isFormat(fmt) {
  return TRACE_FORMATS.includes(fmt);
}

/**
 * One trace, one format. Returns null when the trace is unknown or the format
 * is not recognized — callers should surface the reason rather than guessing.
 * @param {string} traceId
 * @param {'json'|'ndjson'|'otel'|'markdown'|'text'} [format]
 * @param {{pretty?: boolean}} [opts]
 */
export function exportOne(traceId, format = 'json', opts = {}) {
  const trace = exportTrace(traceId);
  if (!trace) return null;
  switch (format) {
    case 'json': return JSON.stringify(trace, null, opts.pretty === false ? 0 : 2);
    case 'ndjson': return JSON.stringify(trace);
    case 'otel': return otelTrace(trace);
    case 'markdown': return mdTrace(trace);
    case 'text': return textTrace(trace);
    default: return null;
  }
}

/**
 * Export several turns. `select` is a filter; a null/empty filter exports the
 * recent window. Returns a string in the requested format — NDJSON for the
 * machine formats (one record per line), a single report for the text ones.
 * @param {{userId?: string|number, chatId?: string|number, status?: string, limit?: number}} select
 * @param {'json'|'ndjson'|'otel'|'markdown'|'text'} [format]
 */
export function exportMany(select = {}, format = 'ndjson') {
  const limit = Math.min(Number(select.limit) || 20, 200);
  const turns = recentTurns({
    userId: select.userId,
    chatId: select.chatId,
    status: select.status,
    limit,
  });
  if (!turns.length) {
    return format === 'markdown' || format === 'text'
      ? 'No agent turns recorded yet.'
      : '';
  }
  if (format === 'markdown' || format === 'text') {
    const lines = turns.map((t) => textOne(t));
    return format === 'markdown' ? fence('trace export', lines.join('\n')) : lines.join('\n');
  }
  const rows = turns.map((t) => exportTrace(t.traceId)).filter(Boolean);
  if (format === 'json') return JSON.stringify(rows, null, 2);
  if (format === 'otel') return rows.map(otelTrace).join('\n');
  return rows.map((t) => JSON.stringify(t)).join('\n'); // ndjson
}

// ---------------------------------------------------------------- formats

/**
 * OpenTelemetry-style trace: one span per provider and tool call, parented to
 * the turn. Not a full OTLP payload (no exporter, no collector, no baggage) —
 * it is the *shape* an OTLP converter expects, and it round-trips through
 * JSON without loss. Timestamps are ms epoch, matching the rest of the store.
 */
function otelTrace(trace) {
  const { turn } = trace;
  const spans = [];
  let idx = 0;
  for (const c of trace.providerCalls) {
    spans.push({
      traceId: turn.traceId,
      spanId: spanId(idx++),
      parentSpanId: null,
      name: `provider ${c.model}`,
      kind: 'client',
      startTimeUnixNano: `${c.startedAt}000000`,
      durationUnixNano: `${Math.max(0, c.ms)}000000`,
      attributes: {
        'gen.system.model': c.model,
        'gen.system.provider': turn.provider || '',
        'gen.usage.prompt_tokens': c.tokens.prompt ?? 0,
        'gen.usage.completion_tokens': c.tokens.completion ?? 0,
        'gen.usage.cached_tokens': c.tokens.cached ?? 0,
        'gen.usage.reasoning_tokens': c.tokens.reasoning ?? 0,
        'gen.usage.total_tokens': c.tokens.total ?? 0,
        ...(c.costUsd === null
          ? { 'gen.cost.unknown': true }
          : { 'gen.cost.usd': c.costUsd }),
      },
      status: { code: c.ok ? 'OK' : 'ERROR', ...(c.errorKind ? { message: c.errorKind } : {}) },
    });
  }
  for (const t of trace.toolCalls) {
    spans.push({
      traceId: turn.traceId,
      spanId: spanId(idx++),
      parentSpanId: null,
      name: `tool ${t.tool}`,
      kind: 'internal',
      startTimeUnixNano: `${t.startedAt}000000`,
      durationUnixNano: `${Math.max(0, t.ms)}000000`,
      attributes: {
        'tool.name': t.tool,
        'tool.result_bytes': t.bytes ?? 0,
        ...(t.inputTokens == null
          ? { 'tool.input_tokens.unknown': true }
          : { 'tool.input_tokens': t.inputTokens }),
        ...(t.costUsd === null
          ? { 'tool.cost.unknown': true }
          : { 'tool.cost.usd': t.costUsd }),
      },
      status: { code: t.ok ? 'OK' : 'ERROR', ...(t.errorMessage ? { message: clip(t.errorMessage, 120) } : {}) },
    });
  }
  return JSON.stringify({
    resourceSpans: [{
      resource: { attributes: { 'service.name': 'opencode-gateway', 'trace.id': turn.traceId } },
      scopeSpans: [{
        scope: { name: 'agent.react-loop' },
        spans,
      }],
    }],
  });
}

function spanId(i) {
  return String(i + 1).padStart(16, '0');
}

/** Human-readable single trace, Markdown-safe for Telegram. */
function mdTrace(trace) {
  return fence('trace', textTrace(trace));
}

function textTrace(trace) {
  const { turn } = trace;
  const cost = formatCost(turn, trace);
  return [
    textOne(turn),
    '',
    `provider calls: ${trace.providerCalls.length}  (${formatMs(trace.timing.providerMs)})`,
    ...trace.providerCalls.map((c) =>
      `  ${c.ok ? 'ok' : 'FAIL'} #${c.turn} ${c.model}  ${formatMs(c.ms)}  ` +
      formatTokens(c.tokens) + (c.priced ? `  $${c.costUsd.toFixed(6)}` : '  (unpriced)')),
    '',
    `tool calls: ${trace.toolCalls.length}  (${formatMs(trace.timing.toolMs)})`,
    ...trace.toolCalls.map((t) =>
      `  ${t.ok ? 'ok' : 'FAIL'} ${t.tool}  ${formatMs(t.ms)}` +
      (t.bytes ? `  ${formatBytes(t.bytes)}` : '') +
      (t.priced ? `  $${t.costUsd.toFixed(6)}` : '')),
    '',
    `cost: ${cost}`,
  ].join('\n');
}

function textOne(t) {
  const cost = t.costUsd === null ? 'cost unknown' : `$${t.costUsd.toFixed(6)}`;
  return `${t.traceId}  ${t.status}  ${formatMs(t.durationMs)}  ${t.turns} turns  ${cost}`;
}

function formatCost(turn, trace) {
  if (turn.costUsd === null) {
    const models = trace.cost.unpricedModels;
    return `unknown (no rate for: ${models.length ? models.join(', ') : 'the model(s) used'})`;
  }
  const calls = trace.cost.pricedCalls;
  return `$${turn.costUsd.toFixed(6)} over ${calls} priced call${calls === 1 ? '' : 's'}` +
    (trace.cost.unpricedCalls ? `  +${trace.cost.unpricedCalls} unpriced` : '');
}

function formatTokens(tk) {
  if (!tk) return 'no usage';
  const parts = [];
  if (tk.prompt) parts.push(`${tk.prompt} in`);
  if (tk.completion) parts.push(`${tk.completion} out`);
  if (tk.cached) parts.push(`${tk.cached} cached`);
  if (tk.reasoning) parts.push(`${tk.reasoning} reason`);
  return parts.join(' ') || '0 tokens';
}

function formatMs(ms) {
  const n = Number(ms) || 0;
  if (n < 1000) return `${n}ms`;
  return `${(n / 1000).toFixed(2)}s`;
}

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v}B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)}KB`;
  return `${(v / (1024 * 1024)).toFixed(2)}MB`;
}

function clip(s, n) {
  const v = String(s ?? '');
  return v.length > n ? `${v.slice(0, n)}…` : v;
}

/**
 * Wrap output in a fence, escaping any nested fence so the model's own output
 * cannot terminate ours mid-record.
 */
function fence(lang, body) {
  const marker = '```';
  const safe = String(body).split(marker).join("\\`\\`\\`");
  return `${marker}${lang}\n${safe}\n${marker}`;
}
