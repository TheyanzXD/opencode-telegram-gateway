// language: JavaScript (Node 20+ ESM), file: src/debugger/tracer.js
// Correlates one agent run: every tool call, approval, provider round, and error
// in order. The engine pushes; anything (logs, /debug command) pulls a trace.

import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';

export class Tracer {
  constructor(id = randomUUID()) {
    this.id = id;
    /** @type {Array<{t: number, type: string, payload: any}>} */
    this.spans = [];
    this.counters = {
      providerCalls: 0,
      toolCalls: 0,
      approvals: 0,
      tokens: 0,
      retries: 0,
    };
    this.t0 = Date.now();
    this.closed = false;
  }

  static forRun() {
    return new Tracer(`run_${Date.now()}`);
  }

  span(type, payload = {}) {
    if (this.closed) return;
    const s = { t: Date.now() - this.t0, type, payload };
    this.spans.push(s);
    return s;
  }

  providerCall(model, ms, ok) {
    this.counters.providerCalls++;
    this.span('provider', { model, ms, ok });
  }

  toolCall(tool, ms, ok, preview) {
    this.counters.toolCalls++;
    this.span('tool', { tool, ms, ok, preview: (preview || '').slice(0, 200) });
  }

  approval(tool, approved, waitedMs) {
    this.counters.approvals++;
    this.span('approval', { tool, approved, waitedMs });
  }

  tokens(n) {
    this.counters.tokens += n;
  }

  error(err, analyzed) {
    this.span('error', {
      kind: analyzed?.kind,
      message: String(err?.message || err).slice(0, 400),
      selfHealable: analyzed?.selfHealable ?? false,
    });
    this.counters.retries += analyzed?.retryable ? 1 : 0;
  }

  close() {
    this.span('close', this.counters);
    this.closed = true;
  }

  /** Render a compact timeline for a human. */
  render(limit = 40) {
    const head = `trace ${this.id} (${Date.now() - this.t0}ms)`;
    const body = this.spans
      .slice(-limit)
      .map((s) => {
        const p = s.payload ? ' ' + JSON.stringify(s.payload) : '';
        return `+${String(s.t).padStart(6)}ms ${s.type}${p}`;
      })
      .join('\n');
    return `${head}\n${body}`;
  }

  /** All errors in this run, newest first. */
  errors() {
    return this.spans.filter((s) => s.type === 'error').map((s) => s.payload);
  }

  /** Attach the whole trace to a pino log line. */
  log(level = 'debug') {
    logger[level]({ trace: this.id, ...this.counters, spans: this.spans.length }, 'trace summary');
  }
}
