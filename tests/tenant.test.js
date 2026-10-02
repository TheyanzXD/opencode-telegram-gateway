import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('tenant: per-user DBs are isolated', async () => {
  process.env.DB_PATH = path.join(os.tmpdir(), `gw-tenant-${Date.now()}.db`);
  process.env.TENANT_DIR = path.join(os.tmpdir(), `gw-tenant-dir-${Date.now()}`);
  const { tenantDb, listTenants, dropTenant } = await import(`../src/tenant.js?ts=${Date.now()}-a`);
  const { addMessage, getHistory } = await import(`../src/tenant_messages.js?ts=${Date.now()}-b`);

  addMessage(1001, 'user', 'hello from user 1001');
  addMessage(1002, 'user', 'hello from user 1002');

  const a = getHistory(1001, 10);
  const b = getHistory(1002, 10);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.match(a[0].content, /user 1001/);
  assert.match(b[0].content, /user 1002/);
  assert.equal(a[0].user_id, 1001);
  assert.equal(b[0].user_id, 1002);

  dropTenant(1001);
  dropTenant(1002);
});

test('memory: FTS5 insert + recall finds chunks', async () => {
  process.env.DB_PATH = path.join(os.tmpdir(), `gw-mem-${Date.now()}.db`);
  process.env.TENANT_DIR = path.join(os.tmpdir(), `gw-mem-dir-${Date.now()}`);
  const { remember, recall, forget } = await import(`../src/memory.js?ts=${Date.now()}-c`);

  const id1 = remember(7777, { source: 'test', body: 'the cat sat on the mat and purred' });
  const id2 = remember(7777, { source: 'test', body: 'dogs love to run in the park' });
  assert.ok(id1 && id2);

  const hits = recall(7777, 'cat mat', 5);
  assert.ok(hits.length >= 1, 'should find at least one match');
  assert.match(hits[0].body, /cat sat/);

  forget(7777, id1);
  forget(7777, id2);
});

test('mcp client: stdio echo subprocess roundtrips JSON-RPC', async () => {
  const { McpClient } = await import(`../src/mcp/client.js?ts=${Date.now()}-d`);
  // Use node -e as a fake stdio MCP server that responds to initialize and tools/list
  const serverScript = `
    let buf = '';
    process.stdin.on('data', d => { buf += d; let n; while ((n = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, n).trim(); buf = buf.slice(n+1); if (!line) continue; const m = JSON.parse(line); if (m.method === 'initialize') { process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:m.id, result:{serverInfo:{name:'echo',version:'1'}, capabilities:{}}}) + '\\n'); } else if (m.method === 'tools/list') { process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:m.id, result:{tools:[{name:'echo', description:'echo input', inputSchema:{type:'object', properties:{text:{type:'string'}}}}]}}) + '\\n'); } else if (m.method === 'tools/call') { process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:m.id, result:{content:[{type:'text', text:'echo: ' + (m.params.arguments.text||'')}]}}) + '\\n'); } else if (m.method === 'notifications/initialized') {} } });
  `;
  const tmp = path.join(os.tmpdir(), `mcp-echo-${Date.now()}.js`);
  fs.writeFileSync(tmp, serverScript);
  const c = new McpClient({ name: 'echo', transport: 'stdio', command: process.execPath, args: [tmp] });
  await c.connect();
  const tools = await c.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'echo');
  const res = await c.callTool('echo', { text: 'hi' });
  assert.match(res.content[0].text, /echo: hi/);
  await c.close();
  fs.unlinkSync(tmp);
});