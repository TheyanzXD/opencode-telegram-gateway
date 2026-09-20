// language: JavaScript (Node 20+ ESM), file: src/agent/tools/subagent.js
// Subagent delegation: spawn a child agent for an independent subtask.
//
// One model, one context. That is the constraint. A task that needs to scan a
// directory and write a summary puts both jobs in one context window; when the
// scan output is large it crowds out the instructions. A subagent does the
// scan in its own window and returns only the result — the parent's context
// stays small.
//
// This mirrors how the orchestrator here delegates: full goal, full context,
// only the summary comes back.

import { z } from 'zod';
import { logger } from '../../logger.js';
import { config } from '../../config.js';

// A subagent gets its own registry so it CANNOT call delegate itself —
// unbounded recursion is the failure mode, and the depth cap is the guard.
const MAX_DEPTH = 2;

const schema = z.object({
  goal: z.string().min(1, 'a goal is required').max(2000),
  context: z.string().max(4000).optional().describe('background the child needs — it sees nothing of this conversation'),
  tools: z.array(z.string()).optional().describe('restrict the child to these tool names; default: read-only set'),
  max_turns: z.number().int().min(1).max(12).optional(),
});

/**
 * Run a subtask in isolation.
 *
 * @param {object} args
 * @param {object} ctx  { userId, chatId, depth }
 */
async function execute({ goal, context, tools, max_turns }, ctx = {}) {
  const depth = (ctx.__depth || 0) + 1;
  if (depth > MAX_DEPTH) {
    return { error: `delegation depth ${depth} exceeds the cap of ${MAX_DEPTH} — inline the work instead` };
  }

  // The child is read-only by default. A scan should not be able to write.
  const allowed = tools && tools.length
    ? tools
    : ['list_dir', 'read_file', 'web_search', 'fetch_url', 'browser_read', 'sysinfo'];

  logger.info({ goal: goal.slice(0, 80), depth, tools: allowed.length }, 'subagent spawned');

  try {
    // Lazy import: the engine is heavy and a bot with agent mode off never needs it.
    const { runSubagent } = await import('../subagent-runner.js');
    const result = await runSubagent({
      goal,
      context: context || '',
      tools: allowed,
      maxTurns: max_turns || 6,
      userId: ctx.userId,
      chatId: ctx.chatId,
      depth,
    });
    return { ok: true, summary: result.summary, turns: result.turns, tools_used: result.toolsUsed };
  } catch (err) {
    logger.error({ err: err.message, goal: goal.slice(0, 60) }, 'subagent failed');
    return { error: String(err.message), ok: false };
  }
}

export const subagentTool = {
  name: 'delegate_task',
  description: 'Spawn a subagent for an independent subtask. It gets its own context window and returns only a summary — use it when a step would flood this context with intermediate output. Read-only tools by default. Max depth 2.',
  schema,
  dangerous: false,
  execute,
};

export const subagentTools = [subagentTool];
export { MAX_DEPTH };
