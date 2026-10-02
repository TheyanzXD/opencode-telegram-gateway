// Minimal MCP (Model Context Protocol) client. JSON-RPC 2.0.
// Transports: stdio (spawn subprocess, newline-delimited JSON) and HTTP (POST).
// ponytail: SSE stream for HTTP responses (current implementation buffers the
// full response; spec allows `application/json` non-streaming as well).

import { spawn } from 'node:child_process';
import { fetch } from 'undici';
import { logger } from '../logger.js';

let nextId = 1;
const newId = () => nextId++;

class RpcTransportError extends Error {
  constructor(err) { super(err.message || JSON.stringify(err)); this.code = err?.code; this.data = err?.data; }
}

export class McpClient {
  constructor({ name, transport, command, args = [], env, url }) {
    this.name = name;
    this.transport = transport;
    this.command = command;
    this.args = args;
    this.env = env;
    this.url = url;
    this.proc = null;
    this.buf = '';
    this.pending = new Map(); // id -> { resolve, reject }
    this.serverInfo = null;
    this.capabilities = null;
    this.connected = false;
    this.tools = null;     // cached
    this.resources = null; // cached
    this.prompts = null;   // cached
  }

  async connect() {
    if (this.transport === 'stdio') await this._connectStdio();
    else if (this.transport === 'http') await this._connectHttp();
    else throw new Error(`mcp[${this.name}]: unknown transport ${this.transport}`);
    const init = await this._request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'opencode-telegram-gateway', version: '1.0.0' },
    });
    this.serverInfo = init.serverInfo || init;
    this.capabilities = init.capabilities || {};
    // initialized notification
    this._notify('notifications/initialized', {});
    this.connected = true;
    logger.info({ name: this.name, server: this.serverInfo }, 'mcp server connected');
    return init;
  }

  async _connectStdio() {
    this.proc = spawn(this.command, this.args, {
      env: { ...process.env, ...(this.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stderr.on('data', (d) => {
      const s = d.toString();
      if (s.trim()) logger.debug({ name: this.name, stderr: s.trim() }, 'mcp stderr');
    });
    this.proc.on('exit', (code) => {
      logger.warn({ name: this.name, code }, 'mcp stdio exited');
      this.connected = false;
      for (const p of this.pending.values()) p.reject(new Error('process exited'));
      this.pending.clear();
    });
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
  }

  _onData(chunk) {
    this.buf += chunk.toString('utf8');
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new RpcTransportError(msg.error));
      else resolve(msg.result);
    }
    // notifications (no id) — log at debug
    else if (msg.method) logger.debug({ name: this.name, method: msg.method }, 'mcp notification');
  }

  _send(obj) {
    if (this.transport === 'stdio') {
      this.proc.stdin.write(JSON.stringify(obj) + '\n');
    } else {
      // http — buffered POST in _request
      throw new Error('use _request for http');
    }
  }

  _notify(method, params) {
    this._send({ jsonrpc: '2.0', method, params: params || {} });
  }

  _request(method, params) {
    const id = newId();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (this.transport === 'stdio') {
        this._send({ jsonrpc: '2.0', id, method, params: params || {} });
      } else {
        const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
        fetch(this.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body,
        }).then(async (res) => {
          const text = await res.text();
          let msg;
          try { msg = JSON.parse(text); } catch { reject(new Error(`mcp http: bad json ${text.slice(0, 200)}`)); return; }
          if (msg.error) reject(new RpcTransportError(msg.error));
          else resolve(msg.result);
        }).catch(reject);
      }
    });
  }

  async _connectHttp() { /* no setup needed */ }

  async listTools() {
    if (this.tools) return this.tools;
    const r = await this._request('tools/list', {});
    this.tools = r.tools || [];
    return this.tools;
  }

  async callTool(name, args) {
    return this._request('tools/call', { name, arguments: args || {} });
  }

  async listResources() {
    if (this.resources) return this.resources;
    const r = await this._request('resources/list', {});
    this.resources = r.resources || [];
    return this.resources;
  }

  async readResource(uri) {
    return this._request('resources/read', { uri });
  }

  async listPrompts() {
    if (this.prompts) return this.prompts;
    const r = await this._request('prompts/list', {});
    this.prompts = r.prompts || [];
    return this.prompts;
  }

  async getPrompt(name, args) {
    return this._request('prompts/get', { name, arguments: args || {} });
  }

  async close() {
    this.connected = false;
    if (this.proc) {
      try { this.proc.kill('SIGTERM'); } catch { /* ignore */ }
    }
  }
}

export class McpRegistry {
  constructor() {
    this.clients = new Map(); // name -> McpClient
  }

  async loadFromConfig(configObj) {
    if (!configObj || typeof configObj !== 'object') return;
    const servers = configObj.servers || {};
    for (const [name, cfg] of Object.entries(servers)) {
      let client;
      if (cfg.url) {
        client = new McpClient({ name, transport: 'http', url: cfg.url });
      } else if (cfg.command) {
        client = new McpClient({ name, transport: 'stdio', command: cfg.command, args: cfg.args || [], env: cfg.env });
      } else {
        logger.warn({ name, cfg }, 'mcp server missing command/url — skipping');
        continue;
      }
      try {
        await client.connect();
        this.clients.set(name, client);
      } catch (err) {
        logger.warn({ name, err: err.message }, 'mcp server failed to connect');
      }
    }
  }

  async allTools(enabledNames) {
    const out = [];
    for (const [name, client] of this.clients) {
      if (enabledNames && !enabledNames.includes(name)) continue;
      try {
        const ts = await client.listTools();
        for (const t of ts) out.push({ server: name, tool: t });
      } catch (err) {
        logger.warn({ name, err: err.message }, 'mcp listTools failed');
      }
    }
    return out;
  }

  async callTool(server, name, args) {
    const c = this.clients.get(server);
    if (!c) throw new Error(`mcp server not loaded: ${server}`);
    return c.callTool(name, args);
  }

  listServers() {
    return [...this.clients.keys()];
  }

  async closeAll() {
    for (const c of this.clients.values()) await c.close().catch(() => {});
    this.clients.clear();
  }
}