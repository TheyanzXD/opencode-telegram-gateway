// language: JavaScript (Node 18+ ESM), file: tests/agent.test.mjs
// Unit tests for the agent layer: registry validation, tool execution,
// approvals, and the engine's tool-calling loop against a fake provider.

import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDefaultRegistry } from '../src/agent/registry.js';
import { createApproval, resolveApproval, getApproval } from '../src/agent/approvals.js';
import { AgentEngine } from '../src/agent/engine.js';

const results = [];
const t = (name, fn) => results.push((async () => { await fn(); console.log(`  ✓ ${name}`); return 0; })().catch((e) => { console.log(`  ✗ ${name}: ${e.message}`); return 1; }));

// sandbox the fs/bash tools in a temp workspace
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'otg-agent-'));
process.env.AGENT_WORKSPACE = tmp;
const { config } = await import('../src/config.js');
config.agent.workspace = tmp;
await fs.writeFile(path.join(tmp, 'hello.txt'), 'first\nsecond\nthird\n');

console.log('registry:');
await t('lists all default tools', () => {
  const reg = createDefaultRegistry();
  assert.ok(reg.has('execute_bash'));
  assert.ok(reg.has('read_file'));
  assert.ok(reg.has('write_file'));
  assert.ok(reg.has('edit_file'));
  assert.ok(reg.has('list_dir'));
  assert.ok(reg.has('web_search'));
  assert.ok(reg.has('fetch_url'));
});

await t('emits OpenAI function schema', () => {
  const reg = createDefaultRegistry();
  const json = reg.toOpenAIJson();
  assert.strictEqual(json[0].type, 'function');
  assert.strictEqual(json[0].function.name, 'execute_bash');
  assert.ok(json[0].function.description.includes('approval'));
});

await t('rejects bad args', () => {
  const reg = createDefaultRegistry();
  const r = reg.validate('read_file', {});
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('path'));
});

await t('read_file returns numbered lines', async () => {
  const reg = createDefaultRegistry();
  const r = await reg.execute('read_file', { path: 'hello.txt' });
  assert.ok(r.content.includes('1|first'));
  assert.ok(r.content.includes('3|third'));
});

await t('write_file then edit_file round-trips', async () => {
  const reg = createDefaultRegistry();
  await reg.execute('write_file', { path: 'sub/new.txt', content: 'alpha beta' });
  const r = await reg.execute('edit_file', { path: 'sub/new.txt', old: 'beta', new: 'gamma' });
  assert.ok(r.content.includes('1 occurrence'));
  const back = await reg.execute('read_file', { path: 'sub/new.txt' });
  assert.ok(back.content.includes('alpha gamma'));
});

await t('edit_file refuses ambiguous match', async () => {
  const reg = createDefaultRegistry();
  await reg.execute('write_file', { path: 'amb.txt', content: 'x x x' });
  const r = await reg.execute('edit_file', { path: 'amb.txt', old: 'x', new: 'y' });
  assert.ok(r.content.includes('3 times'));
});

await t('paths cannot escape the workspace', async () => {
  const reg = createDefaultRegistry();
  const r = await reg.execute('read_file', { path: '../../etc/passwd' });
  assert.ok(r.content.includes('failed') || r.content.includes('escape'));
});

await t('execute_bash runs a command', async () => {
  const reg = createDefaultRegistry();
  const r = await reg.execute('execute_bash', { command: 'echo hi && pwd' });
  assert.ok(r.content.includes('hi'));
  assert.ok(r.content.includes(tmp));
});

await t('execute_bash blocks root-wipe patterns', async () => {
  const reg = createDefaultRegistry();
  const r = await reg.execute('execute_bash', { command: 'rm -rf /' });
  assert.ok(r.content.includes('refused'));
});

console.log('approvals:');
await t('create + resolve parks and unparks the promise', async () => {
  const { id, promise } = createApproval(1, 'execute_bash', { command: 'ls' });
  assert.ok(getApproval(id));
  resolveApproval(id, true);
  assert.strictEqual(await promise, true);
  assert.ok(!getApproval(id));
});

await t('unresolved approval denies after TTL', async () => {
  // short-circuit: resolve false directly to model the expiry path
  const { id, promise } = createApproval(1, 'write_file', { path: 'x' });
  resolveApproval(id, false);
  assert.strictEqual(await promise, false);
});

console.log('engine:');
await t('runs a tool loop and returns the final answer', async () => {
  let n = 0;
  const requestFn = async () => {
    n++;
    if (n === 1) {
      return {
        choices: [{
          message: {
            content: '',
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'list_dir', arguments: '{}' },
            }],
          },
        }],
      };
    }
    return { choices: [{ message: { content: 'done, saw the files' } }], usage: {} };
  };

  const engine = new AgentEngine({
    provider: 'openai', model: 'gpt-4o-mini', requestFn,
  });
  const events = [];
  engine.onEvent = (e) => events.push(e);
  const out = await engine.run({
    messages: [{ role: 'user', content: 'list files' }],
    chatId: 1, userId: 1,
  });
  assert.strictEqual(out, 'done, saw the files');
  assert.ok(events.some((e) => e.type === 'toolStart' && e.tool === 'list_dir'));
  assert.ok(events.some((e) => e.type === 'done'));
  assert.strictEqual(n, 2);
});

await t('stops at maxTurns', async () => {
  const requestFn = async () => ({
    choices: [{ message: { content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'list_dir', arguments: '{}' } }] } }],
  });
  const engine = new AgentEngine({ provider: 'openai', model: 'gpt-4o-mini', maxTurns: 2, requestFn });
  await assert.rejects(() => engine.run({ messages: [{ role: 'user', content: 'loop' }], chatId: 1, userId: 1 }), /max turns/);
});

await t('aborts via signal', async () => {
  const requestFn = async () => ({ choices: [{ message: { content: 'no' } }] });
  const engine = new AgentEngine({ provider: 'openai', model: 'gpt-4o-mini', requestFn });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => engine.run({ messages: [], chatId: 1, userId: 1, signal: ac.signal }), /aborted/);
});

await t('denied approval feeds the loop and continues', async () => {
  let n = 0;
  const requestFn = async () => {
    n++;
    if (n === 1) {
      return {
        choices: [{
          message: {
            content: '',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'execute_bash', arguments: JSON.stringify({ command: 'ls' }) } }],
          },
        }],
      };
    }
    return { choices: [{ message: { content: 'ok, skipped the command' } }] };
  };
  const engine = new AgentEngine({ provider: 'openai', model: 'gpt-4o-mini', requestFn });
  const events = [];
  engine.onEvent = (e) => {
    events.push(e);
    // auto-deny as soon as the keyboard would appear
    if (e.type === 'approvalRequired') resolveApproval(e.id, false);
  };
  const out = await engine.run({ messages: [{ role: 'user', content: 'run ls' }], chatId: 1, userId: 1 });
  assert.strictEqual(out, 'ok, skipped the command');
  assert.ok(events.some((e) => e.type === 'toolEnd' && e.denied));
});

await Promise.all(results);
const bad = results.filter((r) => r === 1).length;
console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
