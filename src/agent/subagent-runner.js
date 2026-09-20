// language: JavaScript (Node 20+ ESM), file: src/agent/subagent-runner.js
// Executes a delegated subtask in an isolated context.
//
// The parent hands over a goal and a tool allowlist. The child runs its own
// ReAct loop against a fresh history, and the only thing that comes back is
// the summary. The parent's context never sees the intermediate tool output.

import { chatCompletion } from '../providers/client.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { createDefaultRegistry } from './registry.js';

const SYSTEM = `You are a subagent. You have ONE goal and a narrow set of tools.

Rules:
- Use the tools, then answer. Do not ask questions — there is no human here.
- When you are done, reply with a summary of what you found or did.
- Keep the summary dense: facts, not narrative. No preamble, no apology.
- If you cannot complete the goal, say exactly what blocked you.`;

/**
 * @param {object} opts { goal, context, tools, maxTurns, userId, chatId, depth }
 */
export async function runSubagent({ goal, context, tools, maxTurns = 6, userId, chatId, depth = 1 }) {
  const registry = createDefaultRegistry();
  const allowed = new Set(tools || []);

  const messages = [
    { role: 'system', content: SYSTEM },
    ...(context ? [{ role: 'system', content: 'Background:\n' + context }] : []),
    { role: 'user', content: goal },
  ];

  const toolsUsed = [];
  let lastAnswer = '';

  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await chatCompletion({
      provider: config.agent?.subagentProvider || process.env.SUBAGENT_PROVIDER || undefined,
      model: config.agent?.subagentModel || process.env.SUBAGENT_MODEL || undefined,
      messages,
      chatId,
      maxTokens: 1200,
    }).catch((err) => {
      // A subagent failure is not fatal to the parent — return the error as the answer.
      return { content: `Subagent error: ${err.message}`, usage: null };
    });

    const content = res?.content || '';
    lastAnswer = content;
    messages.push({ role: 'assistant', content });

    // Tool calls arrive as fenced JSON the model emits; parse them out.
    const calls = parseToolCalls(content);
    if (!calls.length) break; // plain answer → done

    for (const call of calls) {
      if (!allowed.has(call.name)) {
        messages.push({ role: 'system', content: `Tool not allowed for this subtask: ${call.name}` });
        continue;
      }
      const tool = registry.get(call.name);
      if (!tool) { continue; }
      toolsUsed.push(call.name);
      try {
        const out = await tool.execute(call.args, { userId, chatId, __depth: depth });
        messages.push({ role: 'system', content: truncate(JSON.stringify(out)) });
      } catch (err) {
        messages.push({ role: 'system', content: `Tool ${call.name} failed: ${err.message}` });
      }
    }
  }

  return {
    summary: lastAnswer,
    turns: messages.filter((m) => m.role === 'assistant').length,
    toolsUsed,
  };
}

function parseToolCalls(text) {
  // The gateway's convention: fenced ```json blocks with {name, args}.
  const out = [];
  const re = /```(?:json)?\s*([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj && typeof obj === 'object' && obj.name) {
        out.push({ name: String(obj.name), args: obj.args || {} });
      }
    } catch {
      // not a tool call — the model just fenced some content
    }
  }
  return out;
}

function truncate(s, max = 6000) {
  return s.length > max ? s.slice(0, max) + `\n…(${s.length - max} chars more)` : s;
}
