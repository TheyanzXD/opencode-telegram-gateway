// language: JavaScript (Node 20+ ESM), file: tests/debugger.test.mjs
// Tests for error-analyzer, tracer, plugin loader, and rate-limit middleware.

import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { analyze, classify, ERROR_KINDS, extractStatus } from '../src/debugger/error-analyzer.js';
import { Tracer } from '../src/debugger/tracer.js';
import { PluginLoader } from '../src/plugins/loader.js';
import { rateLimitMiddleware } from '../src/bot/middleware/rate-limit.js';

const results = [];
const t = (name, fn) => results.push((async () => { await fn(); console.log(`  ✓ ${name}`); return 0; })().catch((e) => { console.log(`  ✗ ${name}: ${e.message}`); return 1; }));

console.log('error-analyzer:');
await t('classifies an HTTP 401 string as auth', () => {
  assert.strictEqual(classify(new Error('[openai] HTTP 401: invalid api key')), ERROR_KINDS.AUTH);
});
await t('classifies an HTTP 502 string as network', () => {
  assert.strictEqual(classify(new Error('[openai] HTTP 502: bad gateway')), ERROR_KINDS.NETWORK);
});
await t('classifies a 429 with retry hint', () => {
  const a = analyze(new Error('HTTP 429: too many requests'));
  assert.strictEqual(a.kind, ERROR_KINDS.RATE_LIMIT);
  assert.ok(a.retryable);
});
await t('classifies ENOENT as enoent and self-healable', () => {
  const e = new Error('no such file');
  e.code = 'ENOENT';
  const a = analyze(e);
  assert.strictEqual(a.kind, ERROR_KINDS.ENOENT);
  assert.ok(a.selfHealable);
});
await t('classifies a SyntaxError as self-healable', () => {
  const a = analyze(new SyntaxError('Unexpected token }'));
  assert.strictEqual(a.kind, ERROR_KINDS.SYNTAX);
  assert.ok(a.selfHealable);
});
await t('classifies ERR_MODULE_NOT_FOUND', () => {
  const e = new Error("Cannot find module './missing.js'");
  e.code = 'ERR_MODULE_NOT_FOUND';
  assert.strictEqual(classify(e), ERROR_KINDS.MODULE);
});
await t('classifies fetch failed as network + retryable', () => {
  const a = analyze(new Error('fetch failed'));
  assert.strictEqual(a.kind, ERROR_KINDS.NETWORK);
  assert.ok(a.retryable);
});
await t('extracts status from a number, a string, and an object', () => {
  assert.strictEqual(extractStatus(404), 404);
  assert.strictEqual(extractStatus(new Error('HTTP 429: slow down')), 429);
  const e = new Error('x');
  e.status = 500;
  assert.strictEqual(extractStatus(e), 500);
  assert.strictEqual(extractStatus(new Error('no status here')), null);
});
await t('unknown errors are unknown, not retryable', () => {
  const a = analyze(new Error('something weird'));
  assert.strictEqual(a.kind, ERROR_KINDS.UNKNOWN);
  assert.ok(!a.retryable);
  assert.ok(!a.selfHealable);
});

console.log('tracer:');
await t('records spans in order and renders a timeline', () => {
  const tr = new Tracer('test');
  tr.providerCall('m1', 10, true);
  tr.toolCall('list_dir', 5, true, 'a\nb');
  tr.tokens(42);
  tr.error(new Error('boom'), { kind: 'network' });
  tr.close();
  const r = tr.render();
  assert.ok(r.includes('provider'));
  assert.ok(r.includes('tool'));
  assert.ok(r.includes('error'));
  assert.ok(r.includes('close'));
  assert.strictEqual(tr.counters.providerCalls, 1);
  assert.strictEqual(tr.counters.toolCalls, 1);
  assert.strictEqual(tr.counters.tokens, 42);
  assert.strictEqual(tr.errors().length, 1);
  assert.strictEqual(tr.errors()[0].kind, 'network');
});
await t('approval span records wait time and verdict', () => {
  const tr = new Tracer('t2');
  tr.approval('execute_bash', false, 1200);
  assert.strictEqual(tr.counters.approvals, 1);
  assert.strictEqual(tr.spans[0].payload.approved, false);
});

console.log('plugins:');
await t('loads a valid plugin and collects its tools', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plg-'));
  await fs.mkdir(path.join(dir, 'myplugin'));
  await fs.writeFile(
    path.join(dir, 'myplugin', 'index.js'),
    `export default { name: 'myplugin', tools: [{ name: 'ping', description: 'p', parameters: {type:'object',properties:{}}, schema: { safeParse: () => ({success:true,data:{}}) }, execute: async () => 'pong' }] };\n`,
  );
  const loader = new PluginLoader({ dir });
  const loaded = await loader.loadAll();
  assert.strictEqual(loaded.length, 1);
  assert.strictEqual(loaded[0].name, 'myplugin');
  assert.strictEqual(loader.tools().length, 1);
  assert.strictEqual(loader.tools()[0].name, 'ping');
});
await t('a broken plugin is skipped, not fatal', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plg-'));
  await fs.mkdir(path.join(dir, 'bad'));
  await fs.writeFile(path.join(dir, 'bad', 'index.js'), 'throw new Error("nope");\n');
  await fs.mkdir(path.join(dir, 'good'));
  await fs.writeFile(path.join(dir, 'good', 'index.js'), "export default { name: 'good' };\n");
  const loader = new PluginLoader({ dir });
  const loaded = await loader.loadAll();
  assert.strictEqual(loaded.length, 1);
  assert.strictEqual(loaded[0].name, 'good');
  assert.ok(loader.errors.some((e) => e.plugin === 'bad'));
});
await t('a plugin missing a name is rejected', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plg-'));
  await fs.writeFile(path.join(dir, 'x.js'), 'export default { tools: [] };\n');
  const loader = new PluginLoader({ dir });
  const loaded = await loader.loadAll();
  assert.strictEqual(loaded.length, 0);
  assert.strictEqual(loader.errors.length, 1);
});
await t('a missing plugins dir loads nothing and does not throw', async () => {
  const loader = new PluginLoader({ dir: '/nonexistent/plugins' });
  assert.deepEqual(await loader.loadAll(), []);
});
await t('middleware hook is called with the bot', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plg-'));
  await fs.writeFile(path.join(dir, 'm.js'), "export default { name: 'm', middleware: (bot) => { bot.__wired = true } };\n");
  const loader = new PluginLoader({ dir });
  await loader.loadAll();
  const fakeBot = {};
  await loader.attachMiddleware(fakeBot);
  assert.strictEqual(fakeBot.__wired, true);
});
await t('onMessage errors are isolated per plugin', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plg-'));
  await fs.writeFile(path.join(dir, 'a.js'), "export default { name: 'a', onMessage: async () => { throw new Error('x') } };\n");
  await fs.writeFile(path.join(dir, 'b.js'), "export default { name: 'b', onMessage: async (ctx) => { ctx.calls = (ctx.calls||0)+1 } };\n");
  const loader = new PluginLoader({ dir });
  await loader.loadAll();
  const ctx = {};
  await loader.emitMessage(ctx);
  assert.strictEqual(ctx.calls, 1); // b still ran after a threw
});

console.log('rate-limit:');
await t('allows under the limit and blocks over it', async () => {
  let allowed = 0;
  const next = async () => { allowed++ };
  const mw = rateLimitMiddleware({ maxPerMinute: 2, windowMs: 10_000 });
  const mkCtx = () => ({ from: { id: 9 }, session: {}, reply: async () => {} });
  for (let i = 0; i < 2; i++) await mw(mkCtx(), next);
  await mw(mkCtx(), next); // third → blocked
  assert.strictEqual(allowed, 2);
});
await t('admins bypass the limit', async () => {
  let allowed = 0;
  const next = async () => { allowed++ };
  const mw = rateLimitMiddleware({ maxPerMinute: 1, windowMs: 10_000 });
  const mkCtx = () => ({ from: { id: 1 }, session: { isAdmin: true }, reply: async () => {} });
  for (let i = 0; i < 5; i++) await mw(mkCtx(), next);
  assert.strictEqual(allowed, 5);
});
await t('blocked request gets a reply', async () => {
  const mw = rateLimitMiddleware({ maxPerMinute: 1, windowMs: 10_000 });
  let got = null;
  const mkCtx = () => ({ from: { id: 2 }, session: {}, reply: async (t) => { got = t } });
  await mw(mkCtx(), async () => {});
  await mw(mkCtx(), async () => {});
  assert.ok(got && got.includes('Rate limit'));
});

await Promise.all(results);
const bad = results.filter((r) => r === 1).length;
console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
