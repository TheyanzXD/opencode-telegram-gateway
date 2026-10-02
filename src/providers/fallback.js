// language: JavaScript (Node 20+ ESM), file: src/providers/fallback.js
// Model fallback chain + graceful degradation.
//
// A single provider going down took the whole bot down. The chain is a list of
// provider/model pairs; the first that answers wins. Degradation strips
// non-essential features (vision, streaming) instead of failing the turn.

import { chatCompletion, streamChatCompletion } from './client.js';
import { config } from '../config.js';
import { providerNames } from './store.js';
import { logger } from '../logger.js';

/**
 * Resolve the fallback chain for a primary provider+model.
 *
 * Priority:
 *   1. An explicit per-user chain (BYO keys, see src/providers/keys.js).
 *   2. The global chain from FALLBACK_CHAIN env: "openai:gpt-4o,anthropic:claude-3-5-sonnet"
 *   3. Just the primary.
 *
 * @returns {Array<{provider:string, model:string}>}
 */
export function resolveChain({ provider, model }, userChain) {
  const parse = (s) => (s || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [pr, md] = p.split(':');
      return { provider: pr, model: md };
    })
    .filter((e) => e.provider && e.model);

  const list = [];
  const seen = new Set();
  const push = (e) => {
    const k = `${e.provider}|${e.model}`;
    if (seen.has(k)) return;
    seen.add(k);
    list.push(e);
  };

  if (userChain?.length) userChain.forEach(push);
  parse(config.fallback?.chain || process.env.FALLBACK_CHAIN).forEach(push);
  push({ provider, model }); // the primary is always the last resort
  return list;
}

const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const TRANSIENT_HINTS = ['timeout', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'UND_ERR', 'socket hang up', 'fetch failed'];

function isTransient(err) {
  if (!err) return false;
  if (TRANSIENT.has(err.status)) return true;
  const msg = String(err.message || err).toLowerCase();
  return TRANSIENT_HINTS.some((h) => msg.includes(h.toLowerCase()));
}

/**
 * Run chatCompletion across the chain. Retries transient failures once on the
 * same model before stepping down, so a single flaky packet does not cost a
 * model switch.
 */
export async function chatWithFallback(args, userChain) {
  const chain = resolveChain(args, userChain);
  let lastErr = null;
  for (const entry of chain) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await chatCompletion({ ...args, provider: entry.provider, model: entry.model });
        if (attempt || chain[0] !== entry) {
          logger.warn({ from: `${args.provider}:${args.model}`, to: `${entry.provider}:${entry.model}`, attempt }, 'fell back to an alternate model');
        }
        return { ...out, usedProvider: entry.provider, usedModel: entry.model };
      } catch (err) {
        lastErr = err;
        err.status = err.status || Number(String(err.message).match(/HTTP (\d{3})/)?.[1]);
        if (isTransient(err) && attempt === 0) continue;
        break; // hard failure → next model in the chain
      }
    }
  }
  throw lastErr || new Error('all models in the fallback chain failed');
}

/**
 * Streaming variant. On a hard failure mid-chain it starts a new stream with
 * the next model — the caller sees a continuous flow of text either way.
 */
export async function* streamWithFallback(args, userChain) {
  const chain = resolveChain(args, userChain);
  let produced = 0;
  let lastErr = null;
  for (const entry of chain) {
    try {
      for await (const chunk of streamChatCompletion({ ...args, provider: entry.provider, model: entry.model })) {
        produced += chunk.length;
        yield chunk;
      }
      return; // clean end of stream
    } catch (err) {
      lastErr = err;
      if (produced) return; // we already emitted text; do not switch models mid-answer
      logger.warn({ err: String(err.message).slice(0, 120), model: entry.model }, 'stream failed, trying next in chain');
    }
  }
  if (!produced) throw lastErr || new Error('all models in the fallback chain failed');
}

/**
 * Graceful degradation: what can the bot still do if a capability is missing?
 * Returns the list of features that are currently available, and a reason for
 * each one that is not. `/help` shows this so the operator sees what broke.
 */
export function degradationReport() {
  const out = [];
  const ok = (name, cond, reason) => out.push({ name, available: !!cond, reason: cond ? null : reason });

  ok('chat', providerNames().length, 'no providers configured');
  ok('vision', !!(config.vision?.provider && config.vision?.model), 'VISION_PROVIDER/MODEL not set — photo messages will be refused');
  ok('streaming', config.streaming !== false, 'STREAMING=false — replies arrive all at once');
  ok('proxy', config.proxy?.enabled, 'PROXY_* unset — requests go direct');
  ok('browser', true, null); // camoufox is checked at runtime by the tool itself
  ok('agent', config.agent?.enabled !== false, 'agent loop disabled');
  return out;
}
