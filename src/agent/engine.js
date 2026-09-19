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
import { createApproval } from './approvals.js';
import { logger } from '../logger.js';

const MAX_TURN_CHARS = 6000; // a tool result is capped before going back into context

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
  }

  async run({ messages, chatId, userId, signal }) {
    if (!getProvider(this.provider)) throw new Error(`Unknown provider: ${this.provider}`);

    let turns = 0;
    const convo = [...messages]; // mutated as tools append results

    for (;;) {
      if (signal?.aborted) throw new Error('aborted by user');
      if (++turns > this.maxTurns) {
        this.onEvent({ type: 'error', message: `max turns (${this.maxTurns}) reached` });
        throw new Error(`max turns (${this.maxTurns}) reached`);
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
      const data = await this.requestFn(body, signal, chatId);
      const msg = data.choices?.[0]?.message;

      if (!msg) throw new Error('provider returned no message');

      // 1. Visible assistant text — emit as tokens (one chunk, not char-by-char).
      if (msg.content) {
        this.onEvent({ type: 'token', text: msg.content });
      }

      // 2. No tool call → the answer is done.
      if (!msg.tool_calls?.length) {
        this.onEvent({ type: 'done', usage: data.usage, turns });
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
        if (tool?.isDangerous) {
          const { id, promise } = createApproval(userId, name, args);
          this.onEvent({ type: 'approvalRequired', id, tool: name, args });
          const approved = await promise;
          if (!approved) {
            const out = '⛔ denied by user';
            this.onEvent({ type: 'toolEnd', tool: name, output: out, denied: true });
            convo.push(this.toolResult(call.id, name, out));
            continue;
          }
        }

        this.onEvent({ type: 'toolStart', tool: name, args });
        const result = await this.registry.execute(name, args);
        const output = String(result.content).slice(0, MAX_TURN_CHARS);
        this.onEvent({ type: 'toolEnd', tool: name, output, isError: result.isError });

        convo.push(this.toolResult(call.id, name, output));
      }
      // loop back: let the model see the results and continue
    }
  }

  toolResult(toolCallId, name, content) {
    return { role: 'tool', tool_call_id: toolCallId, name, content };
  }
}
