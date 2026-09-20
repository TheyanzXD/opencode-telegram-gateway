// language: JavaScript (Node 20+ ESM), file: src/mcp/client.js
// Model Context Protocol client.
//
// MCP is the open standard for tool servers — connecting one means every MCP
// server on npm becomes a tool this bot can call, without writing a wrapper
// per integration. This is a client over stdio and streamable-HTTP transports.

import { spawn } from 'node:child_process';
import { logger } from '../logger.js';

/** @type {Map<string, {tools: object[], close: () => void}>} */
const _servers = new Map();

let _id = 0;
function nextId() { return ++_id; }

/**
 * Minimal JSON-RPC over stdio for an MCP server.
 *
 * @param {object} cfg { name, command, args?, env?, cwd? }
 * @returns {Promise<{tools: Array<{name, description, input_schema}>}>}
 */
export function connectStdio({ name, command, args = [], env = {}, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buf = '';
    const pending = new Map();
    const tools = [];

    const fail = (reason) => {
      child.kill('SIGKILL');
      reject(new Error(`mcp[${name}]: ${reason}`));
    };

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id && pending.has(msg.id)) {
          const { resolve: ok, reject: no } = pending.get(msg.id);
          pending.delete(msg.id);
          msg.error ? no(new Error(msg.error.message || 'rpc error')) : ok(msg.result);
        }
      }
    });

    child.stderr.on('data', (d) => logger.debug({ server: name, err: d.toString().trim().slice(0, 200) }, 'mcp stderr'));
    child.on('error', (err) => fail(err.message));
    child.on('exit', (code) => {
      if (!_servers.has(name)) return;
      logger.warn({ server: name, code }, 'mcp server exited — dropping its tools');
      _servers.delete(name);
    });

    const send = (method, params) => new Promise((res, rej) => {
      const id = nextId();
      pending.set(id, { resolve: res, reject: rej });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

    send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'opencode-gateway', version: '1.0.0' },
    })
      .then(() => send('tools/list', {}))
      .then((result) => {
        const list = result?.tools || [];
        for (const t of list) {
          tools.push({
            name: `${name}__${t.name}`,
            description: `[${name}] ${t.description || t.name}`,
            input_schema: t.inputSchema,
            // call route: the registry needs the raw server + tool name back
            mcp: { server: name, tool: t.name },
          });
        }
        _servers.set(name, {
          tools,
          close: () => { try { child.kill('SIGTERM'); } catch {} _servers.delete(name); },
          call: (toolName, args) => send('tools/call', { name: toolName, arguments: args }),
        });
        logger.info({ server: name, tools: tools.length }, 'mcp connected');
        resolve({ tools });
      })
      .catch((err) => fail(err.message));

    // The initialize handshake must arrive or the server is not usable.
    setTimeout(() => {
      if (!_servers.has(name) && !tools.length) fail('initialize timed out');
    }, 15_000).unref?.();
  });
}

/**
 * Streamable-HTTP transport for a remote MCP server.
 *
 * @param {object} cfg { name, url, headers? }
 */
export async function connectHttp({ name, url, headers = {} }) {
  // Lazy: undici is heavy to import for a config that may be unused.
  const { fetch } = await import('undici');

  const post = async (method, params) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId(), method, params }),
    });
    if (!res.ok) throw new Error(`mcp[${name}] HTTP ${res.status}`);
    const text = await res.text();
    // The spec allows SSE or a plain JSON body; handle both.
    const payload = text.startsWith('{') ? JSON.parse(text) : parseSse(text);
    if (payload.error) throw new Error(payload.error.message || 'rpc error');
    return payload.result;
  };

  await post('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'opencode-gateway', version: '1.0.0' },
  });

  const result = await post('tools/list', {});
  const tools = (result?.tools || []).map((t) => ({
    name: `${name}__${t.name}`,
    description: `[${name}] ${t.description || t.name}`,
    input_schema: t.inputSchema,
    mcp: { server: name, tool: t.name, http: true },
  }));

  _servers.set(name, {
    tools,
    close: () => _servers.delete(name),
    call: async (toolName, args) => post('tools/call', { name: toolName, arguments: args }),
  });
  logger.info({ server: name, tools: tools.length }, 'mcp(http) connected');
  return { tools };
}

function parseSse(text) {
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (l.startsWith('data:')) {
      try { return JSON.parse(l.slice(5).trim()); } catch {}
    }
  }
  throw new Error('mcp: SSE payload had no JSON event');
}

/** Call a tool on a connected server. Returns the raw MCP result. */
export async function callMcpTool(serverName, toolName, args) {
  const srv = _servers.get(serverName);
  if (!srv) throw new Error(`mcp server not connected: ${serverName}`);
  return srv.call(toolName, args);
}

/** All tools from all connected servers, ready for a tool registry. */
export function allMcpTools() {
  const out = [];
  for (const { tools } of _servers.values()) out.push(...tools);
  return out;
}

export function connectedServers() {
  return [..._servers.keys()];
}

/**
 * Load every server from MCP_SERVERS (JSON array) and return merged tools.
 * One broken server must not break the rest — each is awaited individually.
 *
 * @param {string} json env value: [{"name":"fs","command":"npx","args":["@modelcontextprotocol/server-filesystem","."]}]
 */
export async function loadMcpServers(json) {
  let list = [];
  try { list = JSON.parse(json || '[]'); } catch (err) {
    logger.warn({ err: err.message }, 'MCP_SERVERS is not valid JSON — skipping');
    return [];
  }
  if (!Array.isArray(list)) return [];
  const all = [];
  for (const cfg of list) {
    try {
      const r = cfg.url
        ? await connectHttp(cfg)
        : await connectStdio(cfg);
      all.push(...r.tools);
    } catch (err) {
      logger.warn({ server: cfg.name, err: err.message }, 'mcp server failed to connect');
    }
  }
  return all;
}

export function closeAllMcp() {
  for (const { close } of _servers.values()) close();
}
