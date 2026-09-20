// language: JavaScript (Node 18+ ESM), file: src/agent/engine.js
// ReAct loop over the OpenAI-compatible /chat/completions endpoint the gateway
// already speaks. Streams the final answer, runs tool calls between turns,
// and parks dangerous tools on a deferred promise until Telegram answers.
//
// Non-streaming tool turns + streaming final turn: tool args are not streamed,
// only the assistant's visible answer is. Fewer edits, fewer rate-limit hits.

import { requestJson } from '../providers/client.js';
import { getProvider } from '../providers/store.js';
import { createDefaultRegistry } from './registry.js';
import { createApproval, gateDecision } from './approvals.js';
import { guardianVerdict } from './approval-smart.js';
import { analyze } from '../debugger/error-analyzer.js';
import { canRunDangerous, toolDeniedFor } from './rbac.js';
import { Tracer } from '../debugger/tracer.js';
import { logger } from '../logger.js';

const MAX_TURN_CHARS = 6000; // a tool result is capped before going back into context
const RETRYABLE_MAX = 2;     // provider failures retried per turn before surfacing

export class AgentEngine {
  /**
   * @param {object} opts
   * @param {string} opts.provider
   * @param {string} opts.model
   * @param {number} [opts.maxTurns]   hard cap on tool rounds (default 20)
   * @param {number} [opts.temperature]
   * @param {number} [opts.maxTokens]
   * @param {import('./registry.js').ToolRegistry} [opts.registry]
   * @param {(payload: object) => void} [opts.onEvent]  stream events hook
   * @param {(body: object, signal: AbortSignal, chatId: number) => Promise<object>} [opts.requestFn]
   *        override the provider call — used by tests and by anyone wanting a
   *        different transport. Defaults to the gateway's requestJson.
   */
  constructor(opts) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.maxTurns = opts.maxTurns ?? 20;
    this.temperature = opts.temperature ?? 0.7;
    this.maxTokens = opts.maxTokens ?? 4096;
    this.registry = opts.registry ?? createDefaultRegistry();
    this.onEvent = opts.onEvent ?? (() => {});
    this.requestFn = opts.requestFn ?? ((body, signal, chatId) =>
      requestJson(this.provider, '/chat/completions', body, signal, chatId));
    this.tracer = new Tracer();
  }

  async run({ messages, chatId, userId, signal }) {
    if (!getProvider(this.provider)) throw new Error(`Unknown provider: ${this.provider}`);

    let turns = 0;
    const convo = [...messages]; // mutated as tools append results

    for (;;) {
      if (signal?.aborted) {
        this.tracer.error(new Error('aborted by user'), { kind: 'abort' });
        throw new Error('aborted by user');
      }
      if (++turns > this.maxTurns) {
        const e = new Error(`max turns (${this.maxTurns}) reached`);
        this.tracer.error(e, { kind: 'unknown' });
        this.onEvent({ type: 'error', message: e.message });
        throw e;
      }

      const body = {
        model: this.model,
        messages: convo,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        tools: this.registry.toOpenAIJson(),
        tool_choice: 'auto',
      };

      // Non-streaming request: we need the full message back to read tool_calls.
      // Retryable provider failures (network/timeout/5xx/429) are retried here so
      // a flaky proxy cannot kill a long task; the trace keeps the attempt count.
      let data;
      for (let attempt = 0; ; attempt++) {
        const t0 = Date.now();
        try {
          data = await this.requestFn(body, signal, chatId);
          this.tracer.providerCall(this.model, Date.now() - t0, true);
          break;
        } catch (err) {
          const diag = analyze(err, { attempt });
          this.tracer.providerCall(this.model, Date.now() - t0, false);
          this.tracer.error(err, diag);
          if (signal?.aborted) throw new Error('aborted by user');
          if (diag.retryable && attempt < RETRYABLE_MAX) {
            // 429 honors Retry-After when the provider sends one; others back off linearly
            const after = extractRetryAfter(err);
            const wait = after ?? 800 * (attempt + 1);
            await new Promise((r) => setTimeout(r, Math.min(wait, 20_000)));
            logger.warn({ kind: diag.kind, attempt, wait }, 'provider retry');
            continue;
          }
          this.onEvent({ type: 'error', message: diag.message });
          throw err;
        }
      }
      const msg = data.choices?.[0]?.message;

      if (!msg) {
        const e = new Error('provider returned no message');
        this.tracer.error(e, analyze(e));
        throw e;
      }

      // 1. Visible assistant text — emit as tokens (one chunk, not char-by-char).
      if (msg.content) {
        this.onEvent({ type: 'token', text: msg.content });
        this.tracer.tokens(data.usage?.completion_tokens ?? 0);
      }

      // 2. No tool call → the answer is done.
      if (!msg.tool_calls?.length) {
        this.onEvent({ type: 'done', usage: data.usage, turns });
        this.tracer.close();
        return msg.content || '';
      }

      // The assistant turn must be echoed back verbatim for the provider to
      // accept the following tool results.
      convo.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });

      // 3. Run every requested tool.
      for (const call of msg.tool_calls) {
        const name = call.function.name;
        let args;
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          args = {}; // malformed JSON from the model → let validation report it
        }

        const tool = this.registry.get(name);
        // A tool is gated when it is dangerous, or when this specific call hits a
        // dangerous path — browser_console is read-only, but its `evaluate` runs
        // arbitrary JS in the page and must not slip past the gate.
        // RBAC: an operator-only tool is refused outright, not asked about.
        if (toolDeniedFor(userId, name)) {
          const out = '⛔ this tool is operator-only — your account is not permitted to run it';
          this.onEvent({ type: 'toolEnd', tool: name, output: out, denied: true });
          this.tracer.toolCall(name, 0, false, out);
          convo.push(this.toolResult(call.id, name, out));
          continue;
        }
        const dangerous = tool?.isDangerous || (typeof tool?.requiresApproval === 'function' && tool.requiresApproval(args));
        if (dangerous) {
          // Ask the guardian (cheap model) whether a human needs to look at this.
          // Unavailable or unsure → null → gateDecision falls back to 'ask'.
          const verdict = await guardianVerdict(name, args);
          // RBAC decides who needs a keyboard at all: a trusted role skips it,
          // the same way /yolo does. gateDecision already honors the yolo flag,
          // so this extends that one decision instead of forking the path.
          const decision = canRunDangerous(userId) ? 'allow' : gateDecision(userId, name, verdict);
          this.tracer.span('gate', { tool: name, verdict, decision });

          if (decision === 'allow') {
            // yolo, or guardian judged it safe — run without a keyboard
            this.onEvent({ type: 'toolStart', tool: name, args, autoApproved: true });
          } else if (decision === 'deny') {
            // denial breaker: the user has refused 3 in a row; stop asking
            const out = '⛔ denied (approval fatigue — re-enable with /yolo off first)';
            this.onEvent({ type: 'toolEnd', tool: name, output: out, denied: true });
            this.tracer.toolCall(name, 0, false, out);
            convo.push(this.toolResult(call.id, name, out));
            continue;
          } else {
            const { id, promise } = createApproval(userId, name, args);
            this.onEvent({ type: 'approvalRequired', id, tool: name, args });
            const t0 = Date.now();
            const approved = await promise;
            this.tracer.approval(name, approved, Date.now() - t0);
            if (!approved) {
              const out = '⛔ denied by user';
              this.onEvent({ type: 'toolEnd', tool: name, output: out, denied: true });
              this.tracer.toolCall(name, 0, false, out);
              convo.push(this.toolResult(call.id, name, out));
              continue;
            }
          }
        } else {
          this.onEvent({ type: 'toolStart', tool: name, args });
        }
        const t0 = Date.now();
        const result = await this.registry.execute(name, args, { chatId, userId });
        const output = String(result.content).slice(0, MAX_TURN_CHARS);
        this.onEvent({ type: 'toolEnd', tool: name, output, isError: result.isError });
        this.tracer.toolCall(name, Date.now() - t0, !result.isError, output);

        convo.push(this.toolResult(call.id, name, output));
      }
      // loop back: let the model see the results and continue
    }
  }

  toolResult(toolCallId, name, content) {
    return { role: 'tool', tool_call_id: toolCallId, name, content };
  }
}

/** Pull a Retry-After value (seconds) out of a 429 if the provider sent one. */
function extractRetryAfter(err) {
  const headers = err?.headers;
  if (!headers) return null;
  const v = headers.get?.('retry-after') || headers['retry-after'] || headers['Retry-After'];
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
}
