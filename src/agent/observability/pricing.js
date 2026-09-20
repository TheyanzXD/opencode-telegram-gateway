// language: JavaScript (Node 20+ ESM), file: src/agent/observability/pricing.js
// Model price catalog + cost arithmetic.
//
// The one rule this module never bends: an unpriced model is reported as
// unpriced. It never interpolates a similar model's rate and never returns a
// plausible-looking number it did not compute. A cost figure that might be
// wrong by 10x is worse than no figure — an operator sizing a budget off it
// will make the wrong call either way, but "unknown" tells them to check.
//
// Rates are public list prices in USD per 1 million tokens, as listed by the
// providers at `asOf` below. They move. Override them per-deployment by
// dropping a `pricing.yaml` next to providers.yaml:
//
//   asOf: 2025-01-01
//   models:
//     gpt-4o-mini:
//       prompt: 0.15        # $/M input tokens
//       completion: 0.60    # $/M output tokens
//       cacheRead: 0.075    # $/M cached prompt tokens (optional)
//       cacheWrite: 0.15    # $/M prompt-caching write (optional)
//
// Keys match loosely (see priceFor): provider prefixes, date suffixes, and
// OpenRouter-style `:free` tags are stripped before lookup.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

const PER_M = 1_000_000;
const PRICING_FILE = path.join(config.root, 'pricing.yaml');

/**
 * USD per 1M tokens. prompt/completion are required; cache* are optional.
 * @typedef {{prompt: number, completion: number, cacheRead?: number, cacheWrite?: number}} Rate
 */

/** @type {Record<string, Rate>} */
const BUILT_IN = {
  // ---- OpenAI
  'gpt-4o': { prompt: 2.5, completion: 10.0, cacheRead: 1.25 },
  'gpt-4o-mini': { prompt: 0.15, completion: 0.6, cacheRead: 0.075 },
  'gpt-4.1': { prompt: 2.0, completion: 8.0, cacheRead: 0.5 },
  'gpt-4.1-mini': { prompt: 0.4, completion: 1.6, cacheRead: 0.1 },
  'gpt-4.1-nano': { prompt: 0.1, completion: 0.4, cacheRead: 0.025 },
  'gpt-4-turbo': { prompt: 10.0, completion: 30.0 },
  'gpt-3.5-turbo': { prompt: 0.5, completion: 1.5 },
  'o1': { prompt: 15.0, completion: 60.0, cacheRead: 7.5 },
  'o1-mini': { prompt: 1.1, completion: 4.4, cacheRead: 0.55 },
  'o3': { prompt: 10.0, completion: 40.0, cacheRead: 5.0 },
  'o3-mini': { prompt: 1.1, completion: 4.4, cacheRead: 0.55 },
  'o4-mini': { prompt: 1.1, completion: 4.4, cacheRead: 0.55 },
  // ---- Anthropic (OpenAI-compatible endpoints report these ids verbatim)
  'claude-3-opus': { prompt: 15.0, completion: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-3-sonnet': { prompt: 3.0, completion: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-3-haiku': { prompt: 0.25, completion: 1.25, cacheRead: 0.03, cacheWrite: 0.3 },
  'claude-3-5-sonnet': { prompt: 3.0, completion: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-3-5-haiku': { prompt: 0.8, completion: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
  'claude-3-7-sonnet': { prompt: 3.0, completion: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4': { prompt: 3.0, completion: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-opus-4': { prompt: 15.0, completion: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-haiku-4': { prompt: 0.8, completion: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
  // ---- DeepSeek
  'deepseek-chat': { prompt: 0.27, completion: 1.1, cacheRead: 0.07 },
  'deepseek-reasoner': { prompt: 0.55, completion: 2.19, cacheRead: 0.14 },
  'deepseek-coder': { prompt: 0.14, completion: 0.28 },
  // ---- Google (OpenAI-compatible gateway endpoints)
  'gemini-1.5-flash': { prompt: 0.075, completion: 0.3, cacheRead: 0.01875 },
  'gemini-1.5-pro': { prompt: 1.25, completion: 5.0, cacheRead: 0.3125 },
  'gemini-2.0-flash': { prompt: 0.1, completion: 0.4, cacheRead: 0.025 },
  'gemini-2.5-flash': { prompt: 0.075, completion: 0.3 },
  'gemini-2.5-pro': { prompt: 1.25, completion: 10.0 },
  // ---- Mistral
  'mistral-tiny': { prompt: 0.15, completion: 0.15 },
  'mistral-small': { prompt: 0.2, completion: 0.6 },
  'mistral-medium': { prompt: 0.4, completion: 1.2 },
  'mistral-large': { prompt: 2.0, completion: 6.0 },
  'codestral': { prompt: 0.3, completion: 0.9 },
  // ---- Groq / Together / other fast inference
  'llama-3.3-70b': { prompt: 0.59, completion: 0.79 },
  'llama-3.1-405b': { prompt: 5.0, completion: 15.0 },
  'llama-3.1-70b': { prompt: 0.35, completion: 0.4 },
  'llama-3.1-8b': { prompt: 0.05, completion: 0.08 },
  'llama-4-scout': { prompt: 0.11, completion: 0.34 },
  'llama-4-maverick': { prompt: 0.15, completion: 0.6 },
  'qwen2.5-72b': { prompt: 0.35, completion: 0.4 },
  'qwen3-235b': { prompt: 0.2, completion: 0.6 },
  'gemma2-9b': { prompt: 0.1, completion: 0.1 },
  'mixtral-8x7b': { prompt: 0.24, completion: 0.24 },
  'moonshot-v1-8k': { prompt: 1.2, completion: 1.2 },
  // ---- xAI
  'grok-2': { prompt: 2.0, completion: 10.0 },
  'grok-3': { prompt: 3.0, completion: 15.0 },
  'grok-3-mini': { prompt: 0.3, completion: 0.5 },
};

let _overrides = null;
let _overrideAsOf = null;

/** Load pricing.yaml once; a parse failure is logged and ignored, never fatal. */
function overrides() {
  if (_overrides !== null) return _overrides;
  _overrides = {};
  try {
    if (!fs.existsSync(PRICING_FILE)) return _overrides;
    const raw = YAML.parse(fs.readFileSync(PRICING_FILE, 'utf8'));
    const models = raw?.models || raw?.providers;
    if (models && typeof models === 'object') {
      for (const [k, v] of Object.entries(models)) {
        if (v && typeof v.prompt === 'number' && typeof v.completion === 'number') {
          _overrides[String(k).toLowerCase()] = v;
        }
      }
      _overrideAsOf = raw?.asOf || null;
      logger.info({ file: PRICING_FILE, count: Object.keys(_overrides).length }, 'pricing overrides loaded');
    }
  } catch (err) {
    logger.warn({ err: err.message, file: PRICING_FILE }, 'pricing overrides could not be read — using built-in rates');
    _overrides = {};
  }
  return _overrides;
}

/** Every lookup key worth trying, most specific first. */
function candidates(modelId) {
  const out = [];
  const raw = String(modelId || '').trim();
  if (!raw) return out;
  const lower = raw.toLowerCase();

  // strip an OpenRouter-style availability tag: "deepseek/deepseek-chat-v3:free"
  const base = lower.replace(/:[a-z0-9_-]+$/, '');
  // strip a trailing date: "claude-3-5-sonnet-20241022" / "gpt-4o-2024-08-06"
  const undated = base.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, '');
  // the segment after the last "/" — "myprovider/gpt-4o-mini" → "gpt-4o-mini"
  const last = (undated.includes('/') ? undated.split('/').pop() : undated) || undated;
  const lastBase = (base.includes('/') ? base.split('/').pop() : base) || base;

  for (const c of [lower, base, undated, last, lastBase, last.replace(/-[0-9]{8}$/, '')]) {
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * Look up the rate for a model id. Returns null when nothing matches — the
 * caller must treat that as "unknown price", not as "free".
 * @param {string} modelId
 * @returns {Rate|null}
 */
export function priceFor(modelId) {
  const ov = overrides();
  for (const c of candidates(modelId)) {
    if (ov[c]) return ov[c];
    if (BUILT_IN[c]) return BUILT_IN[c];
  }
  return null;
}

/** True when the catalog has any entry for this model (after normalization). */
export function isPriced(modelId) {
  return priceFor(modelId) !== null;
}

/**
 * Pull token counts out of any usage shape the providers throw at us. The
 * OpenAI spec has prompt_tokens_details / completion_tokens_details; OpenRouter
 * flattens them; some gateways emit only the three top-level numbers.
 * @returns {{prompt:number, completion:number, cached:number, reasoning:number, total:number}}
 */
export function readUsage(usage) {
  const u = usage || {};
  const pd = u.prompt_tokens_details || u.promptTokensDetails || {};
  const cd = u.completion_tokens_details || u.completionTokensDetails || {};
  const prompt = num(u.prompt_tokens ?? u.promptTokens);
  const completion = num(u.completion_tokens ?? u.completionTokens);
  const total = num(u.total_tokens ?? u.totalTokens) || (prompt || 0) + (completion || 0);
  return {
    prompt,
    completion,
    cached: num(pd.cached_tokens ?? pd.cachedTokens),
    reasoning: num(cd.reasoning_tokens ?? cd.reasoningTokens),
    total,
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

/**
 * Cost of one provider call. Never throws; an unpriced model yields priced:false.
 * @param {string} modelId
 * @param {object} usage  provider usage object
 * @returns {{
 *   model: string, rate: Rate|null, priced: boolean,
 *   promptTokens: number, completionTokens: number, cachedTokens: number, reasoningTokens: number,
 *   promptUsd: number, completionUsd: number, cacheReadUsd: number, totalUsd: number,
 * }}
 */
export function costOf(modelId, usage) {
  const { prompt, completion, cached, reasoning, total } = readUsage(usage);
  const rate = priceFor(modelId);
  const base = {
    model: String(modelId || '(unknown)'),
    rate,
    priced: !!rate,
    promptTokens: prompt,
    completionTokens: completion,
    cachedTokens: cached,
    reasoningTokens: reasoning,
    totalTokens: total,
    promptUsd: 0,
    completionUsd: 0,
    cacheReadUsd: 0,
    totalUsd: 0,
  };
  if (!rate) return base;
  // Cached prompt tokens are billed at cacheRead, not the full prompt rate.
  const billablePrompt = Math.max(0, prompt - cached);
  base.promptUsd = (billablePrompt / PER_M) * rate.prompt;
  base.completionUsd = (completion / PER_M) * rate.completion;
  base.cacheReadUsd = (cached / PER_M) * (rate.cacheRead ?? rate.prompt);
  base.totalUsd = base.promptUsd + base.completionUsd + base.cacheReadUsd;
  return base;
}

/** Sum a list of cost records into one total. */
export function sumCosts(rows = []) {
  const acc = {
    calls: 0,
    pricedCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    promptUsd: 0,
    completionUsd: 0,
    cacheReadUsd: 0,
    totalUsd: 0,
  };
  for (const r of rows) {
    acc.calls++;
    if (r.priced) acc.pricedCalls++;
    acc.promptTokens += r.promptTokens;
    acc.completionTokens += r.completionTokens;
    acc.cachedTokens += r.cachedTokens;
    acc.reasoningTokens += r.reasoningTokens;
    acc.totalTokens += r.totalTokens;
    acc.promptUsd += r.promptUsd;
    acc.completionUsd += r.completionUsd;
    acc.cacheReadUsd += r.cacheReadUsd;
    acc.totalUsd += r.totalUsd;
  }
  return acc;
}

/** The catalog as {asOf, models} for /debug and tool reporting. */
export function pricingCatalog() {
  return {
    asOf: _overrideAsOf || '2025-01-list-prices',
    overrides: Object.keys(overrides()).length,
    models: Object.keys({ ...BUILT_IN, ...overrides() }).sort(),
  };
}
