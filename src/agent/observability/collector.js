// language: JavaScript (Node 20+ ESM), file: src/agent/observability/collector.js
// Turns an in-memory Tracer timeline into structured observability records.
//
// The engine owns the Tracer (do not touch engine.js). This module reads one
// after a run and converts its spans into the per-turn cost/timing rows the
// observability store keeps. Nothing here hooks the loop itself; call it from
// wherever the run is already finished — onRunCompleted below is the single
// entry point and it is safe to call after a failure, an abort, or a crash.
//
// Every span type this collector does not understand is counted, not dropped:
// an unknown span is still latency the user paid for, and a future span type
// should show up in the breakdown as "other" until it is taught.

import { logger } from '../../logger.js';
import {
  recordTurn, recordProviderCalls, recordToolCalls,
  getTurn, callsForTurn, toolsForTurn,
} from './store.js';
import { priceFor } from './pricing.js';

/** Span types the collector knows how to attribute. */
const KNOWN = new Set([
  'provider', 'tool', 'approval', 'error', 'gate', 'close', 'done',
]);

/**
 * Convert one Tracer into persistence records.
 *
 * @param {import('../../debugger/tracer.js').Tracer} tracer
 * @param {{
 *   userId?: string|number, chatId?: string|number, sessionId?: string|number,
 *   provider?: string, model?: string, promptText?: string, finalText?: string,
 *   startedAt?: number, finishedAt?: number, turns?: number,
 * }} meta
 * @returns {{turnId: number|null, traceId: string, rows: object, status: string, costUsd: number|null}}
 *          rows is null when persistence failed entirely.
 */
export function collectRun(tracer, meta = {}) {
  const traceId = String(tracer?.id || meta.traceId || '');
  if (!traceId) return { turnId: null, traceId: '', rows: null, status: 'error', costUsd: null };

  const spans = Array.isArray(tracer?.spans) ? tracer.spans : [];
  const rec = {
    traceId,
    userId: meta.userId,
    chatId: meta.chatId,
    sessionId: meta.sessionId,
    provider: meta.provider,
    model: meta.model,
    promptText: meta.promptText,
    finalText: meta.finalText,
    startedAt: meta.startedAt ?? tracer?.t0 ?? Date.now(),
    finishedAt: meta.finishedAt ?? Date.now(),
    turns: meta.turns,
    ...summarize(spans),
  };

  const turnId = recordTurn(rec);
  if (turnId === null) {
    logger.warn({ traceId }, 'observability: turn record not persisted');
    return { turnId: null, traceId, rows: null, status: rec.status, costUsd: null };
  }

  const calls = providerCallsFromSpans(spans, tracer?.t0);
  const tools = toolCallsFromSpans(spans, tracer?.t0);
  recordProviderCalls(traceId, calls);
  recordToolCalls(traceId, tools, calls);

  const rows = getTurn(traceId);
  return {
    turnId,
    traceId,
    rows,
    status: rec.status,
    costUsd: rows?.costUsd ?? null,
  };
}

/**
 * Classify a run's outcome from its spans, without trusting any single one.
 * Order matters: an abort declared after a successful close still means abort.
 */
export function summarize(spans) {
  const out = {
    status: 'ok',
    errorKind: null,
    errorMessage: null,
    approvals: 0,
    providerCalls: 0,
    toolCalls: 0,
    retryAttempts: 0,
    unknownSpans: 0,
  };
  for (const s of spans) {
    if (!KNOWN.has(s.type)) out.unknownSpans++;
    if (s.type === 'provider') {
      out.providerCalls++;
      if (!s.payload?.ok) out.retryAttempts++;
    }
    if (s.type === 'tool') out.toolCalls++;
    if (s.type === 'approval') out.approvals++;
    if (s.type === 'error') {
      out.errorKind = s.payload?.kind || 'unknown';
      out.errorMessage = s.payload?.message ? String(s.payload.message) : null;
    }
  }
  // terminal status, most specific last
  if (spans.some((s) => s.type === 'error' && s.payload?.kind === 'abort')) out.status = 'aborted';
  if (out.errorMessage && /max turns/i.test(out.errorMessage)) out.status = 'max_turns';
  if (spans.some((s) => s.type === 'close')) out.status = out.status === 'aborted' ? 'aborted' : 'ok';
  if (out.status === 'ok' && out.errorKind && out.errorKind !== 'abort') out.status = 'error';
  return out;
}

/** Reconstruct provider-call records from provider spans, with retry attempts. */
export function providerCallsFromSpans(spans, t0 = Date.now()) {
  const out = [];
  let turn = 0;
  let pending = null; // an in-flight attempt awaiting its success span
  for (const s of spans) {
    if (s.type !== 'provider') continue;
    const p = s.payload || {};
    if (p.ok) {
      turn++;
      out.push({
        turn,
        model: String(p.model || '(unknown)'),
        ok: true,
        attempt: pending?.attempt ?? 0,
        ms: Math.max(0, Number(p.ms) || 0),
        usage: p.usage || p.tokenUsage || null,
        startedAt: (t0 || Date.now()) + (Number(s.t) || 0),
      });
      pending = null;
    } else {
      // a failed attempt: hold it so the retry that follows inherits the count
      pending = { attempt: (pending?.attempt ?? 0) + 1 };
      out.push({
        turn: turn + 1,
        model: String(p.model || '(unknown)'),
        ok: false,
        attempt: pending.attempt,
        ms: Math.max(0, Number(p.ms) || 0),
        usage: null,
        errorKind: p.errorKind || 'provider',
        errorMessage: p.message ? String(p.message) : 'provider call failed',
        startedAt: (t0 || Date.now()) + (Number(s.t) || 0),
      });
    }
  }
  return out;
}

/** Reconstruct tool-call records from tool spans. */
export function toolCallsFromSpans(spans, t0 = Date.now()) {
  const out = [];
  for (const s of spans) {
    if (s.type !== 'tool') continue;
    const p = s.payload || {};
    const preview = typeof p.preview === 'string' ? p.preview : '';
    out.push({
      tool: String(p.tool || '(unknown)'),
      ok: p.ok !== false,
      ms: Math.max(0, Number(p.ms) || 0),
      bytes: Buffer.byteLength(preview, 'utf8'),
      errorMessage: p.ok === false ? clip(preview, 1000) : null,
      startedAt: (t0 || Date.now()) + (Number(s.t) || 0),
    });
  }
  return out;
}

function clip(s, n) {
  const v = String(s ?? '');
  return v.length > n ? `${v.slice(0, n)}…` : v;
}

/**
 * Full structured export for one trace — spans, provider calls, tool calls,
 * the cost roll-up, and the pricing provenance. This is what /debug shows and
 * what an export tool serializes.
 */
export function exportTrace(traceId) {
  const turn = getTurn(traceId);
  if (!turn) return null;
  const calls = callsForTurn(traceId);
  const tools = toolsForTurn(traceId);
  const priced = calls.filter((c) => c.priced);
  const unpriced = calls.filter((c) => !c.priced);
  return {
    schema: 'opencode-gateway.trace/v1',
    exportedAt: Date.now(),
    turn,
    providerCalls: calls,
    toolCalls: tools,
    cost: {
      totalUsd: turn.costUsd,
      pricedCalls: priced.length,
      unpricedCalls: unpriced.length,
      unpricedModels: [...new Set(unpriced.map((c) => c.model))],
      rates: [...new Set(priced.flatMap((c) => [c.model]))].map((m) => ({
        model: m,
        rate: priceFor(m),
      })),
    },
    timing: {
      startedAt: turn.startedAt,
      finishedAt: turn.finishedAt,
      durationMs: turn.durationMs,
      providerMs: calls.reduce((a, c) => a + (c.ms || 0), 0),
      toolMs: tools.reduce((a, t) => a + (t.ms || 0), 0),
      approvalCount: turn.approvals,
    },
  };
}

/**
 * The single hook a caller wires into the engine's lifecycle. Call it after
 * `engine.run()` resolves or rejects — it never throws, and it logs at warn
 * (not error) because observability loss is not a run failure.
 *
 * @param {import('../../debugger/tracer.js').Tracer} tracer
 * @param {object} meta  see collectRun
 * @returns {object|null} the persisted turn summary, or null on failure
 */
export function onRunCompleted(tracer, meta = {}) {
  try {
    if (!tracer) return null;
    const res = collectRun(tracer, meta);
    if (res.rows) {
      logger.debug(
        { traceId: res.traceId, status: res.status, costUsd: res.costUsd },
        'observability: turn recorded',
      );
    }
    return res;
  } catch (err) {
    logger.warn({ err: err.message, traceId: tracer?.id }, 'observability collection failed');
    return null;
  }
}
