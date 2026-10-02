import fs from 'node:fs';
import { McpRegistry } from './client.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { findTool } from '../agent/tools.js';

let registry = null;
let ready = false;

export async function loadMcpRegistry() {
  if (!config.mcp.autoStart) { ready = true; return null; }
  if (registry) return registry;
  registry = new McpRegistry();
  if (!fs.existsSync(config.mcp.configPath)) {
    logger.info({ path: config.mcp.configPath }, 'mcp config not found, skipping');
    ready = true;
    return registry;
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(config.mcp.configPath, 'utf8'));
  } catch (err) {
    logger.warn({ err: err.message, path: config.mcp.configPath }, 'mcp config invalid');
    ready = true;
    return registry;
  }
  await registry.loadFromConfig(cfg);
  ready = true;
  return registry;
}

export function getRegistry() {
  return registry;
}

// Combine static tools + mcp tools into OpenAI tools[] format.
// MCP tool names are prefixed `mcp__<server>__<tool>` to avoid collision.
export async function toolsForUser(user, baseDefs) {
  if (!registry || !ready) return baseDefs;
  const enabled = (user?.mcp_servers || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!user?.mcp_enabled || !enabled.length) return baseDefs;
  const mcpTools = await registry.allTools(enabled);
  const mcpDefs = mcpTools.map(({ server, tool }) => ({
    type: 'function',
    function: {
      name: `mcp__${server}__${tool.name}`,
      description: tool.description || `${server}/${tool.name}`,
      parameters: tool.inputSchema || { type: 'object', properties: {} },
    },
  }));
  return [...baseDefs, ...mcpDefs];
}

// Route a tool call by checking static registry first, then MCP.
export async function runToolCall(name, args, ctx) {
  if (name.startsWith('mcp__')) {
    const [, server, ...toolParts] = name.split('__');
    const toolName = toolParts.join('__');
    if (!registry) throw new Error('mcp registry not loaded');
    const res = await registry.callTool(server, toolName, args);
    // MCP tools/call result: { content: [{type:'text', text:'…'}], isError?: bool }
    const text = Array.isArray(res?.content)
      ? res.content.map((c) => c.text || '').join('\n').trim()
      : (res?.text || JSON.stringify(res));
    return res?.isError
      ? { ok: false, error: text || 'mcp tool error' }
      : { ok: true, output: text || '(empty result)' };
  }
  const tool = findTool(name);
  if (!tool) return { ok: false, error: `unknown tool: ${name}` };
  return tool.run(args, ctx);
}

export async function shutdownMcp() {
  if (registry) await registry.closeAll();
  registry = null;
  ready = false;
}