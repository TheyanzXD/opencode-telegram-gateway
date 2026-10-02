// language: JavaScript (Node 18+ ESM), file: src/agent/registry.js
// Tool registry: declare once, expose to the LLM as OpenAI function schema,
// validate args with zod before exec. Execute never throws — errors become
// tool_result content so the loop can recover instead of dying.

import { bashTool } from './tools/bash.js';
import { fsTools } from './tools/fs.js';
import { searchTools } from './tools/search.js';
import { browserTools } from './tools/browser.js';
import { execTools } from './tools/execute.js';
import { fileTools } from './tools/files.js';
import { memoryTools } from './tools/memory.js';
import { subagentTools } from './tools/subagent.js';
import { browserAdvancedTools } from './tools/browser-advanced.js';
import { observabilityTools } from './tools/observability.js';
import { sysinfoTool } from './tools/sysinfo.js';
import { parityTools } from './tools/opencode-parity.js';
import { askUserTool } from './tools/ask-user.js';
import { liveShareTools } from './tools/live-share.js';
import { codeIntelTools } from './tools/code-intel.js';
import { readProTools } from './tools/read-pro.js';
import { sessionProTools } from './tools/session-pro.js';
import { voiceTools } from './tools/voice.js';
import { githubTools } from './tools/github-ops.js';
import { securityScanTools } from './tools/security-scan.js';
import { replTools } from './tools/repl.js';
import { thinkTools } from './tools/think.js';
import { astGrepTools } from './tools/ast-grep.js';
import { mediaTools } from './tools/media.js';

export class ToolRegistry {
  constructor(tools = []) {
    this.tools = new Map(tools.map((t) => [t.name, t]));
  }

  register(tool) {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name) { return this.tools.get(name) || null; }
  has(name) { return this.tools.has(name); }
  names() { return [...this.tools.keys()]; }
  list() { return [...this.tools.values()]; }

  /** OpenAI tool_calls schema for /chat/completions. */
  toOpenAIJson() {
    return this.list().map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description + (t.isDangerous ? ' — requires explicit user approval before running.' : ''),
        parameters: t.parameters,
      },
    }));
  }

  /** Validate args with the tool's zod schema. Returns {ok, data, error}. */
  validate(name, args) {
    const tool = this.get(name);
    if (!tool) return { ok: false, error: `unknown tool: ${name}` };
    // plugins may omit zod — fall back to a permissive check
    if (!tool.schema || !tool.schema.safeParse) {
      return { ok: true, data: args ?? {} };
    }
    const r = tool.schema.safeParse(args ?? {});
    if (!r.success) {
      return { ok: false, error: r.error.issues.map((i) => `${(i.path || []).join('.') || 'root'}: ${i.message}`).join('; ') };
    }
    return { ok: true, data: r.data };
  }

  /**
   * Run one tool. Never throws — a failure is returned as tool_result content.
   * @param {string} name
   * @param {object} args
   * @param {{chatId?: number, userId?: number}} [ctx]  session context for
   *        stateful tools (the browser keeps one page per chat)
   */
  async execute(name, args, ctx = {}) {
    const v = this.validate(name, args);
    if (!v.ok) return { content: `⚠️ invalid arguments: ${v.error}`, isError: true };
    try {
      const out = await this.get(name).execute(v.data, ctx);
      return { content: typeof out === 'string' ? out : JSON.stringify(out), isError: false };
    } catch (err) {
      return { content: `⚠️ ${name} failed: ${err.message}`, isError: true };
    }
  }
}

export function createDefaultRegistry() {
  return new ToolRegistry([
    bashTool, ...fsTools, ...searchTools, ...browserTools,
    ...browserAdvancedTools, ...execTools, ...fileTools, ...memoryTools,
    ...subagentTools, ...observabilityTools, sysinfoTool,
    ...parityTools, askUserTool, ...liveShareTools,
    ...codeIntelTools, ...mediaTools,
    ...readProTools, ...sessionProTools, ...voiceTools,
    ...githubTools, ...securityScanTools, ...replTools,
    ...thinkTools, ...astGrepTools,
  ]);
}
