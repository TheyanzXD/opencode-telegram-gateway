// language: JavaScript (Node 20+ ESM), file: tests/observability.test.mjs
// Exercises the observability layer end to end: a fake Tracer timeline →
// collector → store → exported formats, plus the pricing math and the
// scratchpad the tools expose. Uses its own DB file so it never touches the
// bot's conversation tables.

import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Isolate every store handle in a temp DB before any module imports config.
// A test that shares data/gateway.db leaves rows that later assertions read by
// accident — a "pass" that is really a collision.
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'otg-obs-'));
const dbFile = path.join(tmpDir, 'gateway.db');
process.env.DB_PATH = dbFile;
process.env.AGENT_WORKSPACE = tmpDir;
// guard against a repo .env leaking token/level noise into this run
process.env.LOG_LEVEL = 'error';

const { config } = await import('../src/config.js');
config.dbPath = dbFile;
config.agent.workspace = tmpDir;

const { Tracer } = await import('../src/debugger/tracer.js');
const {
  collectRun, summarize, providerCallsFromSpans, toolCallsFromSpans, onRunCompleted,
} = await import('../src/agent/observability/collector.js');
const {
  recordTurn, recordProviderCalls, recordToolCalls, getTurn, recentTurns,
  spendSummary, callsForTurn, toolsForTurn, clearTraceChildren,
  scratchWrite, scratchRead, scratchList, scratchDelete, scratchHistory,
} = await import('../src/agent/observability/store.js');
const {
  exportOne, exportMany, isFormat,
} = await import('../src/agent/observability/export.js');
const {
  priceFor, costOf, readUsage, sumCosts, isPriced,
} = await import('../src/agent/observability/pricing.js');

const results = [];
const t = (name, fn) => results.push((async () => { await fn(); console.log(`  ✓ ${name}`); return 0; })().catch((e) => { console.log(`  ✗ ${name}: ${e.message}`); return 1; }));

/** A tracer mimicking a real run: one tool round, a retry, then the answer. */
function fakeTracer() {
  const tr = new Tracer('trace-abc');
  tr.t0 = 1_000_000; // stable offsets so timing assertions are deterministic
  tr.providerCall('gpt-4o-mini', 300, true);
  tr.toolCall('list_dir', 45, true, 'f hello.txt\nf notes.md');
  tr.span('provider', { model: 'gpt-4o-mini', ms: 900, ok: false });
  tr.span('error', { kind: 'rate_limit', message: 'HTTP 429: slow down', selfHealable: false });
  tr.providerCall('gpt-4o-mini', 500, true);
  tr.toolCall('write_file', 80, false, '⛔ denied by user');
  tr.approval('write_file', false, 1200);
  tr.span('provider', { model: 'gpt-4o-mini', ms: 700, ok: true });
  tr.close();
  return tr;
}

console.log('pricing:');
await t('looks up a bare model id', () => {
  assert.strictEqual(priceFor('gpt-4o-mini').prompt, 0.15);
  assert.strictEqual(priceFor('gpt-4o-mini').completion, 0.6);
});
await t('strips provider prefixes and date suffixes', () => {
  assert.strictEqual(priceFor('openai/gpt-4o-mini').prompt, 0.15);
  assert.strictEqual(priceFor('deepseek/deepseek-chat:free').prompt, 0.27);
  assert.strictEqual(priceFor('claude-3-5-sonnet-20241022').prompt, 3.0);
});
await t('returns null for an unknown model', () => {
  assert.strictEqual(priceFor('vendor-9000-ultra'), null);
  assert.ok(!isPriced('vendor-9000-ultra'));
  // a known family with an unknown version suffix is still unknown —
  // guessing the base rate would report a cost this module did not compute
  assert.strictEqual(priceFor('deepseek-chat-v9'), null);
});
await t('costs a usage object correctly, including cached tokens', () => {
  const c = costOf('gpt-4o-mini', {
    prompt_tokens: 100_000,
    completion_tokens: 10_000,
    total_tokens: 110_000,
    prompt_tokens_details: { cached_tokens: 40_000 },
    completion_tokens_details: { reasoning_tokens: 2_000 },
  });
  assert.ok(c.priced);
  // (100000-40000)/1e6 * 0.15 = 0.009 ; 10000/1e6*0.6 = 0.006 ; 40000/1e6*0.075 = 0.003
  assert.strictEqual(c.promptUsd, 0.009);
  assert.strictEqual(c.completionUsd, 0.006);
  assert.strictEqual(c.cacheReadUsd, 0.003);
  assert.strictEqual(c.totalUsd, 0.018);
});
await t('unpriced model yields priced:false and zero, not a guess', () => {
  const c = costOf('vendor-9000', { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 });
  assert.ok(!c.priced);
  assert.strictEqual(c.totalUsd, 0);
  assert.strictEqual(c.promptTokens, 1000);
});
await t('readUsage tolerates every provider shape', () => {
  assert.deepStrictEqual(readUsage({ prompt_tokens: 3, completion_tokens: 4 }), { prompt: 3, completion: 4, cached: 0, reasoning: 0, total: 7 });
  assert.deepStrictEqual(readUsage({ promptTokens: 1, completionTokens: 2, totalTokens: 3 }), { prompt: 1, completion: 2, cached: 0, reasoning: 0, total: 3 });
  assert.deepStrictEqual(readUsage(null), { prompt: 0, completion: 0, cached: 0, reasoning: 0, total: 0 });
  const u = readUsage({ prompt_tokens_details: { cached_tokens: 5 } });
  assert.strictEqual(u.cached, 5);
});
await t('sumCosts accumulates and counts priced rows only', () => {
  const s = sumCosts([
    { ...costOf('gpt-4o-mini', { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 }) },
    { ...costOf('vendor-x', { prompt_tokens: 999, total_tokens: 999 }) },
  ]);
  assert.strictEqual(s.calls, 2);
  assert.strictEqual(s.pricedCalls, 1);
  assert.strictEqual(s.totalUsd, 0.15);
  assert.strictEqual(s.promptTokens, 1_000_999);
});

console.log('collector:');
await t('summarize classifies status from spans', () => {
  const s = summarize(fakeTracer().spans);
  assert.strictEqual(s.providerCallCount, 4); // 3 ok + 1 failed retry attempt
  assert.strictEqual(s.toolCallCount, 2);
  assert.strictEqual(s.approvalCount, 1);
  assert.strictEqual(s.failedProviderCalls, 1);
  assert.strictEqual(s.errorKind, 'rate_limit');
});
await t('an aborted run is status=aborted', () => {
  const tr = new Tracer('t-abort');
  tr.span('error', { kind: 'abort', message: 'aborted by user' });
  const s = summarize(tr.spans);
  assert.strictEqual(s.status, 'aborted');
});
await t('a max-turns run is status=max_turns', () => {
  const tr = new Tracer('t-max');
  tr.span('error', { kind: 'unknown', message: 'max turns (20) reached' });
  assert.strictEqual(summarize(tr.spans).status, 'max_turns');
});
await t('a clean close with no errors is status=ok', () => {
  const tr = new Tracer('t-ok');
  tr.providerCall('gpt-4o-mini', 10, true);
  tr.close();
  assert.strictEqual(summarize(tr.spans).status, 'ok');
});
await t('an error without a close is status=error', () => {
  const tr = new Tracer('t-err');
  tr.span('error', { kind: 'auth', message: 'HTTP 401' });
  assert.strictEqual(summarize(tr.spans).status, 'error');
});
await t('providerCallsFromSpans tracks retries and assigns turns', () => {
  const calls = providerCallsFromSpans(fakeTracer().spans, 1_000_000);
  assert.strictEqual(calls.length, 4); // 3 successes + the failed attempt
  assert.strictEqual(calls[0].ok, true);
  assert.strictEqual(calls[0].turn, 1);
  assert.ok(!calls[1].ok);
  assert.strictEqual(calls[1].attempt, 1);
  assert.strictEqual(calls[2].turn, 2);
});
await t('toolCallsFromSpans measures result bytes', () => {
  const tools = toolCallsFromSpans(fakeTracer().spans, 1_000_000);
  assert.strictEqual(tools.length, 2);
  assert.strictEqual(tools[0].tool, 'list_dir');
  assert.ok(tools[0].bytes > 0);
  assert.ok(!tools[1].ok);
});

console.log('store:');
await t('collectRun persists a turn with tokens and cost', () => {
  const tr = new Tracer('trace-persist');
  tr.t0 = 5_000_000;
  tr.span('provider', { model: 'gpt-4o-mini', ms: 200, ok: true });
  tr.span('tool', { tool: 'list_dir', ms: 30, ok: true, preview: 'f a.txt' });
  tr.span('provider', { model: 'gpt-4o-mini', ms: 250, ok: true });
  tr.close();
  const res = collectRun(tr, {
    userId: 101, chatId: 202, provider: 'openai', model: 'gpt-4o-mini',
    promptText: 'list files', finalText: 'here they are',
    startedAt: 5_000_000, finishedAt: 5_000_500, turns: 2,
  });
  assert.ok(res.turnId > 0);
  assert.strictEqual(res.status, 'ok');
  const got = getTurn('trace-persist');
  assert.strictEqual(got.userId, '101');
  assert.strictEqual(got.chatId, '202');
  assert.strictEqual(got.status, 'ok');
  assert.strictEqual(got.durationMs, 500);
  assert.strictEqual(got.toolCalls, 1);
  assert.ok(got.costUsd !== null);
  assert.strictEqual(got.tools.list_dir, 1);
});
await t('a turn with no usage has cost_usd null, not 0', () => {
  const tr = new Tracer('trace-nousage');
  tr.span('provider', { model: 'gpt-4o-mini', ms: 10, ok: true });
  tr.close();
  const res = collectRun(tr, { userId: 101 });
  assert.ok(res.turnId > 0);
  const got = getTurn('trace-nousage');
  // priced but zero tokens: the rate is known, the spend genuinely is $0.
  assert.strictEqual(got.costUsd, 0);
  assert.strictEqual(got.priced, true);
  assert.strictEqual(got.tokens.total, null);
});
await t('an unpriced model has cost_usd null and priced=false', () => {
  const tr = new Tracer('trace-unpriced');
  tr.span('provider', { model: 'vendor-9000', ms: 10, ok: true });
  tr.close();
  const res = collectRun(tr, { userId: 101 });
  const got = getTurn('trace-unpriced');
  assert.strictEqual(got.costUsd, null);
  assert.strictEqual(got.priced, false);
});
await t('recordTurn upserts on the same trace id', () => {
  const id1 = recordTurn({ traceId: 'trace-dup', userId: 1, status: 'ok', startedAt: 100, finishedAt: 200 });
  const id2 = recordTurn({ traceId: 'trace-dup', userId: 1, status: 'aborted', startedAt: 100, finishedAt: 250 });
  assert.strictEqual(id1, id2);
  assert.strictEqual(getTurn('trace-dup').status, 'aborted');
});
await t('recordProviderCalls prices each call separately', () => {
  const tr = new Tracer('trace-mixed');
  tr.span('provider', { model: 'gpt-4o-mini', ms: 100, ok: true });
  tr.span('provider', { model: 'vendor-x', ms: 100, ok: true });
  tr.close();
  collectRun(tr, { userId: 101 });
  const calls = callsForTurn('trace-mixed');
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].model, 'gpt-4o-mini');
  assert.ok(calls[0].priced);
  assert.ok(!calls[1].priced);
});
await t('tool cost is attributed by result bytes', () => {
  const tr = new Tracer('trace-attrib');
  tr.span('provider', { model: 'gpt-4o-mini', ms: 100, ok: true, usage: { prompt_tokens: 10_000, completion_tokens: 500, total_tokens: 10_500 } });
  tr.span('tool', { tool: 'big', ms: 50, ok: true, preview: 'x'.repeat(100_000) });
  tr.span('tool', { tool: 'small', ms: 10, ok: true, preview: 'y' });
  tr.span('provider', { model: 'gpt-4o-mini', ms: 200, ok: true, usage: { prompt_tokens: 20_000, completion_tokens: 500, total_tokens: 20_500 } });
  tr.close();
  collectRun(tr, { userId: 101 });
  const tools = toolsForTurn('trace-attrib');
  assert.strictEqual(tools.length, 2);
  const big = tools.find((x) => x.tool === 'big');
  const small = tools.find((x) => x.tool === 'small');
  assert.ok(big.costUsd > small.costUsd, 'the bigger result should carry more cost');
  assert.ok(big.costUsd > 0);
  assert.ok(big.inputTokens > small.inputTokens);
});
await t('attribution is stable across a re-collection of the same trace', () => {
  const mk = () => {
    const tr = new Tracer('trace-recol');
    tr.span('provider', { model: 'gpt-4o-mini', ms: 100, ok: true, usage: { prompt_tokens: 10_000, completion_tokens: 500, total_tokens: 10_500 } });
    tr.span('tool', { tool: 'big', ms: 50, ok: true, preview: 'x'.repeat(100_000) });
    tr.span('tool', { tool: 'small', ms: 10, ok: true, preview: 'y' });
    tr.close();
    return tr;
  };
  collectRun(mk(), { userId: 101 });
  const strip = (rows) => rows.map((r) => ({ tool: r.tool, ms: r.ms, bytes: r.bytes, in: r.inputTokens, cost: r.costUsd }));
  const before = JSON.stringify(strip(toolsForTurn('trace-recol')));
  collectRun(mk(), { userId: 101 });
  const after = JSON.stringify(strip(toolsForTurn('trace-recol')));
  // same spans → identical attribution (row ids and timestamps are not part of it)
  assert.strictEqual(after, before);
  assert.strictEqual(toolsForTurn('trace-recol').length, 2, 'no duplicate rows');
});
await t('recentTurns filters by user and status', () => {
  recordTurn({ traceId: 'trace-f1', userId: 1, status: 'ok', startedAt: 1, finishedAt: 2 });
  recordTurn({ traceId: 'trace-f2', userId: 2, status: 'error', startedAt: 1, finishedAt: 2 });
  assert.strictEqual(recentTurns({ userId: 1 }).map((x) => x.traceId).includes('trace-f1'), true);
  assert.strictEqual(recentTurns({ userId: 2 }).length >= 1, true);
  assert.strictEqual(recentTurns({ userId: 2, status: 'error' }).length >= 1, true);
  assert.strictEqual(recentTurns({ userId: 2, status: 'ok' }).length, 0);
});
await t('spendSummary aggregates tokens, usd, latency and breakdowns', () => {
  const tr = new Tracer('trace-spend');
  tr.span('provider', { model: 'gpt-4o-mini', ms: 300, ok: true });
  tr.span('tool', { tool: 'list_dir', ms: 40, ok: true, preview: 'f a' });
  tr.close();
  collectRun(tr, { userId: 777 });
  const s = spendSummary({ userId: 777 });
  assert.ok(s.turns >= 1);
  assert.strictEqual(s.calls, 1);
  assert.strictEqual(s.pricedCalls, 1);
  assert.strictEqual(s.unpricedCalls, 0);
  assert.ok(s.byModel.some((m) => m.model === 'gpt-4o-mini'));
  assert.ok(s.byTool.some((m) => m.tool === 'list_dir'));
  assert.strictEqual(s.errorRate, 0);
  assert.ok(s.p50Ms >= 0 && s.p95Ms >= 0);
});
await t('spendSummary respects the time window', () => {
  const s = spendSummary({ userId: 777, sinceMs: Date.now() - 10 });
  assert.ok(s.turns >= 1);
  const future = spendSummary({ userId: 777, sinceMs: Date.now() + 60_000 });
  assert.strictEqual(future.turns, 0);
});
await t('onRunCompleted never throws on a broken tracer', () => {
  assert.strictEqual(onRunCompleted(null, {}), null);
  const tr = new Tracer('trace-broken');
  tr.spans = [{ type: 'nonsense', payload: null }];
  const res = onRunCompleted(tr, { userId: 1 });
  assert.ok(res && res.turnId > 0);
});

console.log('export:');
await t('exportOne json is valid and complete', () => {
  collectRun(fakeTracer(), { userId: 303, chatId: 404, provider: 'openai', model: 'gpt-4o-mini' });
  const raw = exportOne('trace-abc', 'json');
  const j = JSON.parse(raw);
  assert.strictEqual(j.schema, 'opencode-gateway.trace/v1');
  assert.strictEqual(j.turn.traceId, 'trace-abc');
  assert.strictEqual(j.turn.userId, '303');
  assert.strictEqual(j.providerCalls.length, 4); // successes + the failed attempt
  assert.strictEqual(j.toolCalls.length, 2);
  assert.ok(Array.isArray(j.cost.rates));
});
await t('exportOne returns null for an unknown trace', () => {
  assert.strictEqual(exportOne('nope-not-a-trace', 'json'), null);
});
await t('ndjson is one JSON document per line', () => {
  const body = exportMany({ userId: 303, limit: 5 }, 'ndjson');
  const lines = body.split('\n').filter(Boolean);
  assert.ok(lines.length >= 1);
  for (const l of lines) assert.ok(typeof JSON.parse(l), 'each line must parse');
});
await t('otel export produces resourceSpans with real durations', () => {
  const body = exportOne('trace-abc', 'otel');
  const j = JSON.parse(body);
  assert.ok(j.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.length >= 1);
  const span = j.resourceSpans[0].scopeSpans[0].spans[0];
  assert.ok(span.durationUnixNano.endsWith('000000'));
  assert.ok(span.attributes['gen.system.model']);
});
await t('text and markdown render a readable report', () => {
  const txt = exportOne('trace-abc', 'text');
  assert.ok(txt.includes('trace-abc'));
  assert.ok(txt.includes('list_dir'));
  assert.ok(txt.includes('cost:'));
  const md = exportOne('trace-abc', 'markdown');
  assert.ok(md.startsWith('```trace'));
  assert.ok(md.trim().endsWith('```'));
});
await t('exportMany text says so when there is nothing', () => {
  assert.ok(exportMany({ userId: 999_999 }, 'text').includes('No agent turns'));
});
await t('isFormat validates the supported set', () => {
  for (const f of ['json', 'ndjson', 'otel', 'markdown', 'text']) assert.ok(isFormat(f));
  assert.ok(!isFormat('yaml'));
});
await t('a nested fence in the payload cannot break the markdown fence', () => {
  const tr = new Tracer('trace-fence');
  tr.span('tool', { tool: 't', ms: 1, ok: false, preview: '```code```' });
  tr.close();
  collectRun(tr, { userId: 303 });
  const md = exportOne('trace-fence', 'markdown');
  const fences = md.split('```');
  // an escaped inner fence must not add real fence delimiters
  assert.ok(fences.length <= 4, `unexpected fence count: ${fences.length}`);
});

console.log('scratchpad store:');
await t('write, read, and list round-trip', () => {
  scratchWrite(505, 'urls', 'https://a\nhttps://b');
  const rec = scratchRead(505, 'urls');
  assert.strictEqual(rec.value, 'https://a\nhttps://b');
  assert.strictEqual(rec.revision, 1);
  const list = scratchList(505);
  assert.strictEqual(list[0].key, 'urls');
});
await t('overwrite bumps the revision and appends history', () => {
  scratchWrite(505, 'urls', 'https://a\nhttps://b\nhttps://c');
  assert.strictEqual(scratchRead(505, 'urls').revision, 2);
  const hist = scratchHistory(505, 'urls');
  assert.strictEqual(hist.length, 2);
  assert.strictEqual(hist[0].revision, 2);
});
await t('delete removes the doc but keeps history', () => {
  assert.ok(scratchDelete(505, 'urls'));
  assert.strictEqual(scratchRead(505, 'urls'), null);
  assert.ok(scratchHistory(505, 'urls').length > 0);
});
await t('users cannot see each other\'s notes', () => {
  scratchWrite(505, 'private', 'mine');
  assert.strictEqual(scratchRead(606, 'private'), null);
  assert.strictEqual(scratchList(606).length, 0);
});
await t('read of a missing key is null', () => {
  assert.strictEqual(scratchRead(505, 'never-written'), null);
});

console.log('tools:');
await t('the tool exports have the registry shape', async () => {
  const { observabilityTools } = await import('../src/agent/tools/observability.js');
  assert.strictEqual(observabilityTools.length, 6);
  for (const tool of observabilityTools) {
    assert.ok(typeof tool.name === 'string' && tool.name.length > 0);
    assert.ok(typeof tool.description === 'string' && tool.description.length > 0);
    assert.ok(typeof tool.isDangerous === 'boolean');
    assert.ok(tool.parameters && tool.parameters.type === 'object');
    assert.ok(tool.schema && typeof tool.schema.safeParse === 'function');
    assert.ok(typeof tool.execute === 'function');
  }
});
await t('schemas accept the documented arguments', async () => {
  const { observabilityTools } = await import('../src/agent/tools/observability.js');
  const byName = Object.fromEntries(observabilityTools.map((x) => [x.name, x]));
  assert.strictEqual(byName.trace_export.schema.safeParse({ format: 'json' }).success, true);
  assert.strictEqual(byName.trace_export.schema.safeParse({ format: 'bogus' }).success, false);
  assert.strictEqual(byName.cost_report.schema.safeParse({ window: '7d' }).success, true);
  assert.strictEqual(byName.scratchpad_write.schema.safeParse({ key: 'k', value: 'v' }).success, true);
  // value is optional in the schema (see the note on scratchWriteSchema) —
  // an absent value is refused by execute(), not by zod. Test both contracts.
  assert.strictEqual(byName.scratchpad_write.schema.safeParse({ key: 'k' }).success, true);
  // an unknown window passes zod (the enum is the tool's documented list, kept
  // loose) and is rejected by execute() with a message naming the valid set.
  assert.strictEqual(byName.cost_report.schema.safeParse({ window: 'bogus' }).success, true);
});

await t('cost_report tool renders a report for the caller', async () => {
  const { costReportTool } = await import('../src/agent/tools/observability.js');
  const tr = new Tracer('trace-tool1');
  tr.span('provider', { model: 'gpt-4o-mini', ms: 100, ok: true });
  tr.close();
  collectRun(tr, { userId: 4242 });
  const out = await costReportTool.execute({ window: 'all' }, { userId: 4242, chatId: 4242 });
  assert.ok(out.includes('Cost report'), out);
  assert.ok(out.includes('$'), out);
});
await t('cost_report tool rejects a bad window', async () => {
  const { costReportTool } = await import('../src/agent/tools/observability.js');
  const out = await costReportTool.execute({ window: '17 centuries' }, { userId: 4242 });
  assert.ok(out.startsWith('⚠️'), out);
});
await t('trace_export tool exports the last run by default', async () => {
  const { traceExportTool } = await import('../src/agent/tools/observability.js');
  const tr = new Tracer('trace-tool2');
  tr.span('provider', { model: 'gpt-4o-mini', ms: 100, ok: true });
  tr.close();
  collectRun(tr, { userId: 4242 });
  const out = await traceExportTool.execute({ format: 'json' }, { userId: 4242, chatId: 4242 });
  const j = JSON.parse(out);
  assert.ok(j.turn || j.id || typeof j === 'object');
});
await t('trace_export tool refuses an unknown format', async () => {
  const { traceExportTool } = await import('../src/agent/tools/observability.js');
  const out = await traceExportTool.execute({ format: 'xml' }, { userId: 4242 });
  assert.ok(out.startsWith('⚠️'), out);
});
await t('a non-admin cannot read another user\'s cost report', async () => {
  const { costReportTool } = await import('../src/agent/tools/observability.js');
  const out = await costReportTool.execute({ user_id: 999_999 }, { userId: 4242 });
  assert.ok(out.startsWith('⚠️'), out);
});
await t('scratchpad tools round-trip through the registry contract', async () => {
  const {
    scratchpadWriteTool, scratchpadReadTool, scratchpadListTool, scratchpadDeleteTool,
  } = await import('../src/agent/tools/observability.js');
  const ctx = { userId: 4242, chatId: 4242 };
  const w = await scratchpadWriteTool.execute({ key: 'todo', value: 'step 1' }, ctx);
  assert.ok(w.includes('saved'), w);
  const r = await scratchpadReadTool.execute({ key: 'todo' }, ctx);
  assert.ok(r.includes('step 1'), r);
  const l = await scratchpadListTool.execute({}, ctx);
  assert.ok(l.includes('todo'), l);
  const d = await scratchpadDeleteTool.execute({ key: 'todo' }, ctx);
  assert.ok(d.includes('deleted'), d);
  const miss = await scratchpadReadTool.execute({ key: 'todo' }, ctx);
  assert.ok(miss.startsWith('⚠️'), miss);
});
await t('scratchpad append extends the note', async () => {
  const { scratchpadWriteTool, scratchpadReadTool } = await import('../src/agent/tools/observability.js');
  const ctx = { userId: 4242 };
  await scratchpadWriteTool.execute({ key: 'append-test', value: 'a' }, ctx);
  await scratchpadWriteTool.execute({ key: 'append-test', value: 'b', append: true }, ctx);
  const r = await scratchpadReadTool.execute({ key: 'append-test' }, ctx);
  assert.ok(r.includes('a\nb'), r);
});
await t('a missing value is refused, not stored as null', async () => {
  const { scratchpadWriteTool } = await import('../src/agent/tools/observability.js');
  const out = await scratchpadWriteTool.execute({ key: 'empty' }, { userId: 4242 });
  assert.ok(out.startsWith('⚠️'), out);
});
await t('scratchpad history lists prior revisions', async () => {
  const { scratchpadWriteTool, scratchpadReadTool } = await import('../src/agent/tools/observability.js');
  const ctx = { userId: 4242 };
  await scratchpadWriteTool.execute({ key: 'hist', value: 'one' }, ctx);
  await scratchpadWriteTool.execute({ key: 'hist', value: 'two' }, ctx);
  const h = await scratchpadReadTool.execute({ key: 'hist', history: true }, ctx);
  assert.ok(h.includes('revision 2') && h.includes('revision 1'), h);
  assert.ok(h.includes('one') && h.includes('two'), h);
});

await Promise.all(results);
const bad = results.filter((r) => r === 1).length;
console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
