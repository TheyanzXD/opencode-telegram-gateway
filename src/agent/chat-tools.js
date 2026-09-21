// language: JavaScript (Node 20+ ESM), file: src/agent/chat-tools.js
// Tool-calling in plain chat — not just /agent.
//
// Before this, only /agent ran the registry. Plain messages went straight to
// the LLM as a stateless chatbot: no tools list, no awareness brief, so
// "can you edit a file?" got the generic "no" — the model had no idea it was
// sitting on a real host with tools.
//
// The fix is not a new command, it is wiring the same loop the engine already
// has into the plain-chat path: the body carries `tools`, the model may reply
// with `tool_calls`, we run them (with the same approval/RBAC gates) and feed
// the results back. The user never types /agent; tools are there by default.
//
// Approval rendering reuses the presenter so the inline keyboard works the
// same way in chat as it does in /agent.

import { requestJson, chatCompletion } from '../providers/client.js';
import { getProvider } from '../providers/store.js';
import { createDefaultRegistry } from './registry.js';
import { createApproval, gateDecision } from './approvals.js';
import { guardianVerdict } from './approval-smart.js';
import { canRunDangerous, toolDeniedFor } from './rbac.js';
import { logger } from '../logger.js';

const MAX_TURN_CHARS = 6000;

/**
 * Run a full chat turn with tools. Returns the final assistant content.
 *
 * `sendToolStatus(name, args, output)` lets the caller show progress/result
 * lines in the message being streamed. Approvals are rendered by the caller
 * via `onApproval(id, tool, args)` when present, else auto-approve (yolo).
 */
export async function chatWithTools({
  provider, model, messages, chatId, userId,
  temperature, maxTokens, maxTurns = 20,
  registry = createDefaultRegistry(),
  onApproval = null,   // (id, tool, args) => void ; null → auto-allow
  sendToolStatus = null,
  stream = null,       // (args) => AsyncIterable<string> — when set, the final
                       // (non-tool) turn is streamed through this instead of the
                       // non-streaming request. Tool turns stay non-streaming.
  onStreamChunk = null,
}) {
  if (!getProvider(provider)) throw new Error(`Unknown provider: ${provider}`);

  let convo = messages.slice();
  const body = () => ({
    model,
    messages: convo,
    temperature,
    max_tokens: maxTokens,
    tools: registry.toOpenAIJson(),
    tool_choice: 'auto',
  });

  for (let turn = 0; turn < maxTurns; turn++) {
    // Tool turns must read the full message to find tool_calls, so they are
    // always non-streaming here. When the caller wants a visible stream, we
    // do a single non-streaming probe turn; if it turns out to be the final
    // (no tool_calls) turn we re-issue it through the stream. That costs one
    // extra request per final turn, which is the price of a live stream in a
    // tool loop — and only on the last turn, where accuracy beats latency.
    const data = await requestJson(provider, '/chat/completions', body(), null, chatId);
    const msg = data.choices?.[0]?.message || {};
    const content = msg.content || '';
    const toolCalls = msg.tool_calls || [];

    if (toolCalls.length) convo.push({ role: 'assistant', content, tool_calls: toolCalls });
    else {
      convo.push({ role: 'assistant', content });
      if (stream) {
        // Stream the final turn.
        let acc = '';
        for await (const chunk of stream({
          provider, model, messages: convo, chatId,
          temperature, maxTokens,
        })) {
          acc += chunk;
          onStreamChunk?.(acc);
        }
        return { content: acc || content, convo };
      }
      return { content, convo };
    }

    for (const call of toolCalls) {
      const name = call.function?.name;
      let args = {};
      try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = {}; }

      if (toolDeniedFor(userId, name)) {
        const out = '⛔ this tool is operator-only — your account is not permitted to run it';
        convo.push({ role: 'tool', tool_call_id: call.id, name, content: out });
        sendToolStatus?.(name, args, out);
        continue;
      }

      const tool = registry.get(name);
      const dangerous = tool?.isDangerous || (typeof tool?.requiresApproval === 'function' && tool.requiresApproval(args));

      if (dangerous) {
        // Same gate as the engine: guardian, then RBAC, then keyboard.
        const verdict = await guardianVerdict(name, args);
        const decision = canRunDangerous(userId) ? 'allow' : gateDecision(userId, name, verdict);
        if (decision === 'allow') {
          // trusted role or yolo — run without a keyboard
        } else if (decision === 'deny') {
          const out = '⛔ denied (approval fatigue — re-enable with /yolo off first)';
          convo.push({ role: 'tool', tool_call_id: call.id, name, content: out });
          sendToolStatus?.(name, args, out);
          continue;
        } else if (onApproval) {
          const { id, promise } = createApproval(userId, name, args);
          onApproval(id, name, args);
          const approved = await promise;
          if (!approved) {
            const out = '⛔ denied by user';
            convo.push({ role: 'tool', tool_call_id: call.id, name, content: out });
            sendToolStatus?.(name, args, out);
            continue;
          }
        }
        // onApproval === null → auto-allow (the caller opted out of the gate)
      }

      const t0 = Date.now();
      const result = await registry.execute(name, args, { chatId, userId });
      const output = String(result.content).slice(0, MAX_TURN_CHARS);
      logger.debug({ tool: name, ms: Date.now() - t0, isError: result.isError }, 'chat tool ran');
      sendToolStatus?.(name, args, output);
      convo.push({ role: 'tool', tool_call_id: call.id, name, content: output });
    }
    // loop back: let the model see the tool results
  }
  return { content: '⚠️ reached the tool-turn cap without a final answer.', convo };
}
