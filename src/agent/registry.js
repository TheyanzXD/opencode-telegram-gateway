// language: JavaScript (Node 18+ ESM), file: src/agent/registry.js
// Tool registry: declare once, expose to the LLM as OpenAI function schema,
// validate args with zod before exec. Execute never throws — errors become
// tool_result content so the loop can recover instead of dying.

import { bashTool } from './tools/bash.js';
import { fsTools } from './tools/fs.js';
import { searchTools } from './tools/search.js';

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
    const r = tool.schema.safeParse(args ?? {});
    if (!r.success) {
      return { ok: false, error: r.error.issues.map((i) => `${(i.path || []).join('.') || 'root'}: ${i.message}`).join('; ') };
    }
    return { ok: true, data: r.data };
  }

  /** Run one tool. Never throws — a failure is returned as tool_result content. */
  async execute(name, args) {
    const v = this.validate(name, args);
    if (!v.ok) return { content: `⚠️ invalid arguments: ${v.error}`, isError: true };
    try {
      const out = await this.get(name).execute(v.data);
      return { content: typeof out === 'string' ? out : JSON.stringify(out), isError: false };
    } catch (err) {
      return { content: `⚠️ ${name} failed: ${err.message}`, isError: true };
    }
  }
}

export function createDefaultRegistry() {
  return new ToolRegistry([bashTool, ...fsTools, ...searchTools]);
}
