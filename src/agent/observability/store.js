// language: JavaScript (Node 20+ ESM), file: src/agent/observability/store.js
// Persistence for the observability layer: one row per completed agent turn,
// one row per provider call inside it, plus a working-file scratchpad.
//
// Own handle, same file as db.js. The chat schema is db.js's business and it is
// imported by nearly every module in the bot; observability is write-heavy and
// experiment-prone, and a broken migration here must never take the bot's
// conversation tables down with it. better-sqlite3 handles concurrent handles
// on a WAL database without blocking.
//
// All writes are wrapped: an observability failure is a diagnostic loss, never
// a lost agent turn. Every public function degrades to a no-op + warn log.

import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { costOf, readUsage, sumCosts } from './pricing.js';

let _db = null;

function handle() {
  if (_db) return _db;
  _db = new Database(config.dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.exec(`
    -- One completed agent turn: a single /agent prompt through the loop and
    -- back. The unit of cost attribution — the row /spend and /debug read.
    CREATE TABLE IF NOT EXISTS obs_turns (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id      TEXT NOT NULL UNIQUE,
      user_id       TEXT NOT NULL,
      chat_id       TEXT,
      session_id    TEXT,
      provider      TEXT,
      model         TEXT,
      prompt_text   TEXT,
      final_text    TEXT,
      status        TEXT NOT NULL,        -- ok | error | aborted | max_turns
      error_kind    TEXT,
      error_message TEXT,
      turns         INTEGER NOT NULL DEFAULT 0,
      started_at    INTEGER NOT NULL,
      finished_at   INTEGER,
      duration_ms   INTEGER,
      -- accumulated tokens (what the provider reported; unpriced is null)
      prompt_tokens     INTEGER,
      completion_tokens INTEGER,
      cached_tokens     INTEGER,
      reasoning_tokens  INTEGER,
      total_tokens      INTEGER,
      -- accumulated USD; null when no provider call could be priced
      cost_usd          REAL,
      priced_calls      INTEGER NOT NULL DEFAULT 0,
      provider_calls    INTEGER NOT NULL DEFAULT 0,
      tool_calls        INTEGER NOT NULL DEFAULT 0,
      approvals         INTEGER NOT NULL DEFAULT 0,
      retry_attempts    INTEGER NOT NULL DEFAULT 0,
      tools             TEXT,             -- JSON: {name: count}
      created_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_obs_turns_user  ON obs_turns(user_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_obs_turns_chat  ON obs_turns(chat_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_obs_turns_time  ON obs_turns(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_obs_turns_status ON obs_turns(status);

    -- One provider call. A turn with 5 tool rounds is 6 rows here, which is
    -- where "the third round was 70% of the budget" actually becomes visible.
    CREATE TABLE IF NOT EXISTS obs_provider_calls (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id      TEXT NOT NULL,
      turn          INTEGER NOT NULL,        -- loop iteration, 1-based
      model         TEXT NOT NULL,
      ok            INTEGER NOT NULL,        -- 1 success, 0 failure
      attempt       INTEGER NOT NULL DEFAULT 0,
      ms            INTEGER NOT NULL,
      prompt_tokens     INTEGER,
      completion_tokens INTEGER,
      cached_tokens     INTEGER,
      reasoning_tokens  INTEGER,
      total_tokens      INTEGER,
      cost_usd          REAL,               -- null = model not in the catalog
      rate_prompt       REAL,
      rate_completion   REAL,
      error_kind        TEXT,
      error_message     TEXT,
      started_at        INTEGER NOT NULL,
      FOREIGN KEY(trace_id) REFERENCES obs_turns(trace_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_obs_calls_trace ON obs_provider_calls(trace_id, turn);
    CREATE INDEX IF NOT EXISTS idx_obs_calls_model ON obs_provider_calls(model, started_at DESC);

    -- Per-tool cost and latency attribution. A turn's provider bill is spent
    -- mostly reading tool output back in; assigning it per tool turns "the
    -- fetch_url call cost $0.012" from a guess into a measurement.
    CREATE TABLE IF NOT EXISTS obs_tool_calls (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id   TEXT NOT NULL,
      tool       TEXT NOT NULL,
      ok         INTEGER NOT NULL,
      ms         INTEGER NOT NULL,
      bytes      INTEGER,                   -- result size fed back into context
      -- share of the turn's prompt cost attributable to this call's result
      -- (input growth it caused, minus the cached fraction)
      input_tokens   INTEGER,
      cost_usd       REAL,
      error_message  TEXT,
      started_at     INTEGER NOT NULL,
      FOREIGN KEY(trace_id) REFERENCES obs_turns(trace_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_obs_tools_trace ON obs_tool_calls(trace_id);
    CREATE INDEX IF NOT EXISTS idx_obs_tools_name  ON obs_tool_calls(tool, started_at DESC);

    -- Working-file scratchpad: per-user, per-key JSON documents with revision
    -- history. Used by the scratchpad tool; kept here (not in the workspace)
    -- because a scratch doc is structured state, not a file the user edits.
    CREATE TABLE IF NOT EXISTS obs_scratch (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    TEXT NOT NULL,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      bytes      INTEGER NOT NULL,
      revision   INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_obs_scratch_user ON obs_scratch(user_id, updated_at DESC);

    -- Every scratch write, kept. Undo on a scratch doc is not "restore the
    -- file" — it is "go back to the value two writes ago".
    CREATE TABLE IF NOT EXISTS obs_scratch_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    TEXT NOT NULL,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      bytes      INTEGER NOT NULL,
      revision   INTEGER NOT NULL,
      written_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_obs_scratch_hist ON obs_scratch_history(user_id, key, revision DESC);
  `);
  logger.info({ dbPath: config.dbPath }, 'observability store ready');
  return _db;
}

/** Run a write; any SQLite error is logged and swallowed. */
function write(stmt, params, what) {
  try {
    const db = handle();
    return stmt(db).run(...params);
  } catch (err) {
    logger.warn({ err: err.message, what }, 'observability write failed');
    return null;
  }
}

/** Run a read; on error returns the fallback so callers never see a throw. */
function read(stmt, params, fallback) {
  try {
    return stmt(handle()).all(...params);
  } catch (err) {
    logger.warn({ err: err.message }, 'observability read failed');
    return fallback;
  }
}

// ---------------------------------------------------------------- turns

const STMT_TURN_UPSERT = (db) => db.prepare(`
  INSERT INTO obs_turns (
    trace_id, user_id, chat_id, session_id, provider, model,
    prompt_text, final_text, status, error_kind, error_message,
    turns, started_at, finished_at, duration_ms,
    prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens, total_tokens,
    cost_usd, priced_calls, provider_calls, tool_calls, approvals, retry_attempts,
    tools, created_at
  ) VALUES (
    @trace_id, @user_id, @chat_id, @session_id, @provider, @model,
    @prompt_text, @final_text, @status, @error_kind, @error_message,
    @turns, @started_at, @finished_at, @duration_ms,
    @prompt_tokens, @completion_tokens, @cached_tokens, @reasoning_tokens, @total_tokens,
    @cost_usd, @priced_calls, @provider_calls, @tool_calls, @approvals, @retry_attempts,
    @tools, @created_at
  )
  ON CONFLICT(trace_id) DO UPDATE SET
    final_text   = excluded.final_text,
    status       = excluded.status,
    error_kind   = excluded.error_kind,
    error_message= excluded.error_message,
    turns        = excluded.turns,
    finished_at  = excluded.finished_at,
    duration_ms  = excluded.duration_ms,
    prompt_tokens     = excluded.prompt_tokens,
    completion_tokens = excluded.completion_tokens,
    cached_tokens     = excluded.cached_tokens,
    reasoning_tokens  = excluded.reasoning_tokens,
    total_tokens      = excluded.total_tokens,
    cost_usd          = excluded.cost_usd,
    priced_calls      = excluded.priced_calls,
    provider_calls    = excluded.provider_calls,
    tool_calls        = excluded.tool_calls,
    approvals         = excluded.approvals,
    retry_attempts    = excluded.retry_attempts,
    tools             = excluded.tools
`);

/**
 * Persist one turn. `rec` is a plain object; unknown keys are ignored so a
 * caller passing extras does not break the insert.
 * @returns {number|null} the row id, or null on failure
 */
export function recordTurn(rec) {
  const now = Date.now();
  const started = Number(rec.startedAt) || now;
  const finished = Number(rec.finishedAt) || now;
  const rows = Array.isArray(rec.providerCalls) ? rec.providerCalls : [];
  const tools = Array.isArray(rec.toolCalls) ? rec.toolCalls : [];
  const toolCounts = {};
  for (const t of tools) toolCounts[t.tool] = (toolCounts[t.tool] || 0) + 1;

  const costs = rows.map((r) => costOf(r.model, r.usage));
  const totals = sumCosts(costs);
  // The turn has a known spend only if at least one call was priced. A
  // best-effort partial number silently implies full coverage, and a zero
  // would read as "free" — so unpriced turns are stored as NULL, not 0.
  const anyPriced = totals.pricedCalls > 0;
  const tokenTotals = rows.reduce(
    (a, r) => {
      const u = readUsage(r.usage);
      a.prompt += u.prompt;
      a.completion += u.completion;
      a.cached += u.cached;
      a.reasoning += u.reasoning;
      return a;
    },
    { prompt: 0, completion: 0, cached: 0, reasoning: 0 },
  );

  const params = {
    trace_id: String(rec.traceId || ''),
    user_id: String(rec.userId ?? ''),
    chat_id: rec.chatId == null ? null : String(rec.chatId),
    session_id: rec.sessionId == null ? null : String(rec.sessionId),
    provider: rec.provider || null,
    model: rec.model || null,
    prompt_text: clip(rec.promptText, 2000),
    final_text: clip(rec.finalText, 2000),
    status: ['ok', 'error', 'aborted', 'max_turns'].includes(rec.status) ? rec.status : 'error',
    error_kind: rec.errorKind || null,
    error_message: clip(rec.errorMessage, 1000),
    turns: Number(rec.turns) || 0,
    started_at: started,
    finished_at: finished,
    duration_ms: Math.max(0, finished - started),
    prompt_tokens: tokenTotals.prompt || null,
    completion_tokens: tokenTotals.completion || null,
    cached_tokens: tokenTotals.cached || null,
    reasoning_tokens: tokenTotals.reasoning || null,
    total_tokens: totals.totalTokens || null,
    cost_usd: anyPriced ? round6(totals.totalUsd) : null,
    priced_calls: totals.pricedCalls,
    provider_calls: rows.length,
    tool_calls: tools.length,
    approvals: Number(rec.approvalCount) || 0,
    retry_attempts: rows.reduce((a, r) => a + (Number(r.attempt) || 0), 0),
    tools: Object.keys(toolCounts).length ? JSON.stringify(toolCounts) : null,
    created_at: now,
  };
  const r = write(STMT_TURN_UPSERT, [params], 'recordTurn');
  return r?.lastInsertRowid ?? null;
}

const STMT_CALL_INSERT = (db) => db.prepare(`
  INSERT INTO obs_provider_calls (
    trace_id, turn, model, ok, attempt, ms,
    prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens, total_tokens,
    cost_usd, rate_prompt, rate_completion, error_kind, error_message, started_at
  ) VALUES (
    @trace_id, @turn, @model, @ok, @attempt, @ms,
    @prompt_tokens, @completion_tokens, @cached_tokens, @reasoning_tokens, @total_tokens,
    @cost_usd, @rate_prompt, @rate_completion, @error_kind, @error_message, @started_at
  )
`);

/** Insert provider-call rows for a turn; each gets its own cost computation. */
export function recordProviderCalls(traceId, calls = []) {
  if (!calls.length) return 0;
  let n = 0;
  for (const c of calls) {
    const cost = costOf(c.model, c.usage);
    const params = {
      trace_id: String(traceId),
      turn: Number(c.turn) || 1,
      model: String(c.model || '(unknown)'),
      ok: c.ok ? 1 : 0,
      attempt: Number(c.attempt) || 0,
      ms: Math.max(0, Number(c.ms) || 0),
      prompt_tokens: cost.promptTokens || null,
      completion_tokens: cost.completionTokens || null,
      cached_tokens: cost.cachedTokens || null,
      reasoning_tokens: cost.reasoningTokens || null,
      total_tokens: cost.totalTokens || null,
      cost_usd: cost.priced ? round6(cost.totalUsd) : null,
      rate_prompt: cost.priced ? cost.rate.prompt : null,
      rate_completion: cost.priced ? cost.rate.completion : null,
      error_kind: c.ok ? null : c.errorKind || null,
      error_message: c.ok ? null : clip(c.errorMessage, 1000),
      started_at: Number(c.startedAt) || Date.now(),
    };
    if (write(STMT_CALL_INSERT, [params], 'recordProviderCalls')) n++;
  }
  return n;
}

const STMT_TOOL_INSERT = (db) => db.prepare(`
  INSERT INTO obs_tool_calls (
    trace_id, tool, ok, ms, bytes, input_tokens, cost_usd, error_message, started_at
  ) VALUES (
    @trace_id, @tool, @ok, @ms, @bytes, @input_tokens, @cost_usd, @error_message, @started_at
  )
`);

/**
 * Persist tool-call rows and assign each a share of the turn's cost.
 *
 * Attribution: a tool call's *output* is what grows the next request's input,
 * so its cost is the prompt-token cost of the bytes it added — proportional to
 * its share of the total result bytes, times the turn's prompt-token bill. Not
 * exact (the model also reads its own reasoning and the accumulated results),
 * but it is the right *shape*: the tool that returned 40 KB into a 50 KB
 * context is charged for 80% of the input, and that tracks the real bill.
 * Unpriced turns propagate `null` rather than a fabricated 0.
 *
 * Input-token attribution is index-based: rows are inserted in span order, so
 * the i-th call in this array is the i-th row for that trace+tool. Span
 * identity is not carried by the Tracer, so this is the only stable anchor —
 * and it means a re-collection with the same spans rewrites identical values.
 */
export function recordToolCalls(traceId, toolCalls = [], providerCalls = []) {
  if (!toolCalls.length) return 0;
  const costs = providerCalls.map((r) => costOf(r.model, r.usage));
  const totals = sumCosts(costs);
  const promptUsd = totals.pricedCalls ? totals.promptUsd : null;
  const promptTokens = totals.promptTokens > 0 ? totals.promptTokens : 0;
  const totalBytes = toolCalls.reduce((a, t) => a + (Number(t.bytes) || 0), 0);
  // Rows already present for each (trace, tool), before this batch lands.
  // Insert order is span order, so row index within a trace+tool identifies
  // the call — the Tracer carries no per-span id to key on instead.
  const hadByTool = new Map();
  for (const t of toolCalls) {
    const k = String(t.tool || '(unknown)');
    if (hadByTool.has(k)) continue;
    hadByTool.set(
      k,
      read((db) => db.prepare('SELECT COUNT(*) AS c FROM obs_tool_calls WHERE trace_id = ? AND tool = ?'), [String(traceId), k], [{ c: 0 }])[0]?.c || 0,
    );
  }

  let n = 0;
  for (const t of toolCalls) {
    const name = String(t.tool || '(unknown)');
    const bytes = Number(t.bytes) || 0;
    const share = totalBytes > 0 ? bytes / totalBytes : 0;
    const costUsd = promptUsd === null ? null : round6(promptUsd * share);
    const params = {
      trace_id: String(traceId),
      tool: name,
      ok: t.ok ? 1 : 0,
      ms: Math.max(0, Number(t.ms) || 0),
      bytes: bytes || null,
      input_tokens: null, // stamped in the second pass
      cost_usd: costUsd,
      error_message: t.ok ? null : clip(t.errorMessage, 1000),
      started_at: Number(t.startedAt) || Date.now(),
    };
    if (write(STMT_TOOL_INSERT, [params], 'recordToolCalls')) n++;
  }
  // Second pass: attribute input tokens by the same share, so the cost and the
  // token count tell the same story. A share that rounds to zero tokens (a
  // 1-byte result in a 100 KB context) still gets its cost — the dollar figure
  // is exact where the token count cannot be.
  if (promptTokens > 0 && totalBytes > 0) {
    const counts = new Map(); // tool → how many of this batch have been stamped
    for (const t of toolCalls) {
      const name = String(t.tool || '(unknown)');
      const i = counts.get(name) || 0;
      counts.set(name, i + 1);
      const tok = Math.round(promptTokens * ((Number(t.bytes) || 0) / totalBytes));
      if (tok <= 0) continue;
      // This batch's i-th row for `name`, offset past any rows a previous
      // collection of the same trace already left behind.
      const row = read(
        (db) => db.prepare('SELECT id, input_tokens FROM obs_tool_calls WHERE trace_id = ? AND tool = ? ORDER BY id ASC LIMIT 1 OFFSET ?'),
        [String(traceId), name, (hadByTool.get(name) || 0) + i],
        [],
      )[0];
      if (row && row.input_tokens !== tok) attributeInputTokens(row.id, tok);
    }
  }
  return n;
}

const STMT_ATTR_INPUT_ID = (db) => db.prepare('UPDATE obs_tool_calls SET input_tokens = ? WHERE id = ?');

/** Stamp an attributed input-token count onto a specific row. */
function attributeInputTokens(id, tokens) {
  write(STMT_ATTR_INPUT_ID, [tokens, id], 'attributeInputTokens');
}

// ---------------------------------------------------------------- reads

/**
 * Drop a trace's per-call rows. The turn row upserts; the children do not, so a
 * re-collection clears them first to stay idempotent. Cascades would do this
 * for a delete; this keeps the turn and rebuilds only its children.
 */
export function clearTraceChildren(traceId) {
  write(
    (db) => db.prepare('DELETE FROM obs_provider_calls WHERE trace_id = ?'),
    [String(traceId)],
    'clearTraceChildren.calls',
  );
  write(
    (db) => db.prepare('DELETE FROM obs_tool_calls WHERE trace_id = ?'),
    [String(traceId)],
    'clearTraceChildren.tools',
  );
}

/** Decorate raw turn rows with the shape the API/tools return. */
function shapeTurn(r) {
  if (!r) return null;
  return {
    id: r.id,
    traceId: r.trace_id,
    userId: r.user_id,
    chatId: r.chat_id,
    sessionId: r.session_id,
    provider: r.provider,
    model: r.model,
    status: r.status,
    errorKind: r.error_kind,
    errorMessage: r.error_message,
    turns: r.turns,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationMs: r.duration_ms,
    promptPreview: r.prompt_text,
    finalPreview: r.final_text,
    tokens: {
      prompt: r.prompt_tokens,
      completion: r.completion_tokens,
      cached: r.cached_tokens,
      reasoning: r.reasoning_tokens,
      total: r.total_tokens,
    },
    costUsd: r.cost_usd,
    priced: r.cost_usd !== null,
    pricedCalls: r.priced_calls,
    providerCalls: r.provider_calls,
    toolCalls: r.tool_calls,
    approvals: r.approvals,
    retryAttempts: r.retry_attempts,
    tools: r.tools ? safeJson(r.tools) : {},
  };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

export function getTurn(traceId) {
  const rows = read((db) => db.prepare('SELECT * FROM obs_turns WHERE trace_id = ?'), [String(traceId)], []);
  return shapeTurn(rows[0]);
}

export function lastTurn(userId) {
  const rows = read((db) => db.prepare('SELECT * FROM obs_turns WHERE user_id = ? ORDER BY started_at DESC LIMIT 1'), [String(userId)], []);
  return shapeTurn(rows[0]);
}

export function recentTurns({ userId = null, chatId = null, limit = 20, status = null } = {}) {
  const conds = [];
  const params = [];
  if (userId != null) { conds.push('user_id = ?'); params.push(String(userId)); }
  if (chatId != null) { conds.push('chat_id = ?'); params.push(String(chatId)); }
  if (status) { conds.push('status = ?'); params.push(status); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = read(
    (db) => db.prepare(`SELECT * FROM obs_turns ${where} ORDER BY started_at DESC LIMIT ?`),
    [...params, Math.min(limit, 200)],
    [],
  );
  return rows.map(shapeTurn);
}

/** Provider calls for one turn, in order. */
export function callsForTurn(traceId) {
  return read(
    (db) => db.prepare('SELECT * FROM obs_provider_calls WHERE trace_id = ? ORDER BY turn ASC, id ASC'),
    [String(traceId)],
    [],
  ).map((r) => ({
    id: r.id,
    turn: r.turn,
    model: r.model,
    ok: !!r.ok,
    attempt: r.attempt,
    ms: r.ms,
    tokens: {
      prompt: r.prompt_tokens,
      completion: r.completion_tokens,
      cached: r.cached_tokens,
      reasoning: r.reasoning_tokens,
      total: r.total_tokens,
    },
    costUsd: r.cost_usd,
    ratePrompt: r.rate_prompt,
    rateCompletion: r.rate_completion,
    priced: r.cost_usd !== null,
    errorKind: r.error_kind,
    errorMessage: r.error_message,
    startedAt: r.started_at,
  }));
}

/** Tool calls for one turn, in order. */
export function toolsForTurn(traceId) {
  return read(
    (db) => db.prepare('SELECT * FROM obs_tool_calls WHERE trace_id = ? ORDER BY id ASC'),
    [String(traceId)],
    [],
  ).map((r) => ({
    id: r.id,
    tool: r.tool,
    ok: !!r.ok,
    ms: r.ms,
    bytes: r.bytes,
    inputTokens: r.input_tokens,
    costUsd: r.cost_usd,
    priced: r.cost_usd !== null,
    errorMessage: r.error_message,
    startedAt: r.started_at,
  }));
}

/**
 * Aggregate spend over a window, with per-model and per-tool breakdowns.
 * Unpriced calls are counted but never averaged into the cost.
 * @returns {{
 *   turns: number, calls: number, pricedCalls: number, unpricedCalls: number,
 *   promptTokens: number, completionTokens: number, totalTokens: number,
 *   totalUsd: number, avgPerTurnUsd: number, p50Ms: number, p95Ms: number,
 *   errorRate: number, byModel: Array, byTool: Array,
 * }}
 */
export function spendSummary({ userId = null, sinceMs = null, untilMs = null, limit = 1000 } = {}) {
  const conds = [];
  const params = [];
  if (userId != null) { conds.push('user_id = ?'); params.push(String(userId)); }
  if (sinceMs != null) { conds.push('started_at >= ?'); params.push(Number(sinceMs)); }
  if (untilMs != null) { conds.push('started_at < ?'); params.push(Number(untilMs)); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const turns = read(
    (db) => db.prepare(`SELECT * FROM obs_turns ${where} ORDER BY started_at DESC LIMIT ?`),
    [...params, Math.min(limit, 5000)],
    [],
  );
  const traceIds = turns.map((t) => t.trace_id);
  const calls = traceIds.length
    ? read(
        (db) => db.prepare(`SELECT * FROM obs_provider_calls WHERE trace_id IN (${q(traceIds)}) ORDER BY id ASC`),
        traceIds,
        [],
      )
    : [];
  const tools = traceIds.length
    ? read(
        (db) => db.prepare(`SELECT * FROM obs_tool_calls WHERE trace_id IN (${q(traceIds)}) ORDER BY id ASC`),
        traceIds,
        [],
      )
    : [];

  const costs = calls.map((c) => ({
    priced: c.cost_usd !== null,
    promptTokens: c.prompt_tokens || 0,
    completionTokens: c.completion_tokens || 0,
    cachedTokens: c.cached_tokens || 0,
    reasoningTokens: c.reasoning_tokens || 0,
    totalTokens: c.total_tokens || 0,
    promptUsd: (c.cost_usd !== null && c.prompt_tokens) ? (c.cost_usd * (c.prompt_tokens / Math.max(1, c.total_tokens || 1))) : 0,
    completionUsd: 0,
    cacheReadUsd: 0,
    totalUsd: c.cost_usd || 0,
  }));
  const totals = sumCosts(costs);
  const durations = turns.map((t) => t.duration_ms || 0).sort((a, b) => a - b);
  const errors = turns.filter((t) => t.status !== 'ok').length;
  const usd = totals.totalUsd;

  const byModel = new Map();
  for (const c of calls) {
    const k = c.model;
    if (!byModel.has(k)) byModel.set(k, { model: k, calls: 0, pricedCalls: 0, tokens: 0, usd: 0, errors: 0, ms: 0 });
    const m = byModel.get(k);
    m.calls++;
    m.ms += c.ms || 0;
    if (!c.ok) m.errors++;
    if (c.cost_usd !== null) { m.pricedCalls++; m.usd += c.cost_usd; }
    m.tokens += c.total_tokens || 0;
  }
  const byTool = new Map();
  for (const t of tools) {
    const k = t.tool;
    if (!byTool.has(k)) byTool.set(k, { tool: k, calls: 0, errors: 0, ms: 0, bytes: 0, usd: 0, pricedCalls: 0 });
    const m = byTool.get(k);
    m.calls++;
    m.ms += t.ms || 0;
    m.bytes += t.bytes || 0;
    if (!t.ok) m.errors++;
    if (t.cost_usd !== null) { m.pricedCalls++; m.usd += t.cost_usd; }
  }

  return {
    window: { sinceMs: sinceMs ?? null, untilMs: untilMs ?? null, userId: userId == null ? null : String(userId) },
    turns: turns.length,
    calls: calls.length,
    pricedCalls: totals.pricedCalls,
    unpricedCalls: calls.length - totals.pricedCalls,
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    cachedTokens: totals.cachedTokens,
    reasoningTokens: totals.reasoningTokens,
    totalTokens: totals.totalTokens,
    totalUsd: round6(usd),
    avgPerTurnUsd: turns.length ? round6(usd / turns.length) : 0,
    avgTurnMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
    p50Ms: pct(durations, 0.5),
    p95Ms: pct(durations, 0.95),
    errorRate: turns.length ? errors / turns.length : 0,
    byModel: [...byModel.values()].map((m) => ({ ...m, usd: round6(m.usd), avgMs: m.calls ? Math.round(m.ms / m.calls) : 0 })).sort((a, b) => b.usd - a.usd),
    byTool: [...byTool.values()].map((m) => ({ ...m, usd: round6(m.usd), avgMs: m.calls ? Math.round(m.ms / m.calls) : 0, avgBytes: m.calls ? Math.round(m.bytes / m.calls) : 0 })).sort((a, b) => b.ms - a.ms),
  };
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[i];
}

/** Build a (?, ?, …) placeholder list. */
function q(list) {
  return list.map(() => '?').join(',');
}

function clip(s, n) {
  const v = String(s ?? '');
  return v.length > n ? `${v.slice(0, n)}…` : v;
}

function round6(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : 0;
}

// ---------------------------------------------------------------- scratchpad

const STMT_SCRATCH_GET = (db) => db.prepare('SELECT * FROM obs_scratch WHERE user_id = ? AND key = ?');
const STMT_SCRATCH_UPSERT = (db) => db.prepare(`
  INSERT INTO obs_scratch (user_id, key, value, bytes, revision, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, key) DO UPDATE SET
    value = excluded.value,
    bytes = excluded.bytes,
    revision = excluded.revision,
    updated_at = excluded.updated_at
`);
const STMT_SCRATCH_HIST = (db) => db.prepare(`
  INSERT INTO obs_scratch_history (user_id, key, value, bytes, revision, written_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const STMT_SCRATCH_LIST = (db) => db.prepare(`
  SELECT key, bytes, revision, created_at, updated_at FROM obs_scratch
  WHERE user_id = ? ORDER BY updated_at DESC
`);
const STMT_SCRATCH_DELETE = (db) => db.prepare('DELETE FROM obs_scratch WHERE user_id = ? AND key = ?');
const STMT_SCRATCH_HIST_GET = (db) => db.prepare(`
  SELECT value, bytes, revision, written_at FROM obs_scratch_history
  WHERE user_id = ? AND key = ? ORDER BY revision DESC LIMIT ?
`);

/**
 * Write a scratch doc. JSON-encodes non-strings so the tool can hand it an
 * object; the stored form is always text.
 * @returns {{key:string, bytes:number, revision:number, createdAt:number, updatedAt:number}}
 */
export function scratchWrite(userId, key, value) {
  const db = handle();
  const uid = String(userId ?? '0');
  const k = String(key || '').trim();
  if (!k) throw new Error('scratch key is required');
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const now = Date.now();
  const prev = db.prepare('SELECT revision FROM obs_scratch WHERE user_id = ? AND key = ?').get(uid, k);
  const revision = (prev?.revision ?? 0) + 1;
  const bytes = Buffer.byteLength(text, 'utf8');
  write(STMT_SCRATCH_UPSERT, [uid, k, text, bytes, revision, now, now], 'scratchWrite');
  write(STMT_SCRATCH_HIST, [uid, k, text, bytes, revision, now], 'scratchWrite.history');
  return { key: k, bytes, revision, createdAt: now, updatedAt: now };
}

/** Read a scratch doc. Returns null when it does not exist. */
export function scratchRead(userId, key) {
  const rows = read(STMT_SCRATCH_GET, [String(userId ?? '0'), String(key || '').trim()], []);
  return rows[0]
    ? {
        key: rows[0].key,
        value: rows[0].value,
        bytes: rows[0].bytes,
        revision: rows[0].revision,
        createdAt: rows[0].created_at,
        updatedAt: rows[0].updated_at,
      }
    : null;
}

export function scratchList(userId) {
  return read(STMT_SCRATCH_LIST, [String(userId ?? '0')], []);
}

export function scratchDelete(userId, key) {
  const r = write(STMT_SCRATCH_DELETE, [String(userId ?? '0'), String(key || '').trim()], 'scratchDelete');
  return r?.changes > 0;
}

/** Revision history for a scratch doc, newest first. */
export function scratchHistory(userId, key, limit = 20) {
  return read(STMT_SCRATCH_HIST_GET, [String(userId ?? '0'), String(key || '').trim(), Math.min(limit, 100)], []);
}

export function closeObservability() {
  try { _db?.close(); } catch { /* ignore */ }
  _db = null;
}
