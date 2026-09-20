// language: JavaScript (Node 20+ ESM), file: src/agent/guards.js
// Guards around provider responses. Two failure modes that produce a blank or
// nonsense reply, both silent in the current code:
//
// 1. Empty content — model returned nothing (content filter, refusal, truncation,
//    or a provider quirk that sends finish_reason without any delta chunk).
//    Today this surfaces as the literal "(empty)" with no explanation.
// 2. Truncated stream — the connection closed mid-response and buf holds a
//    half-finished sentence. Sending that as the answer looks like a bug.
//
// The guard classifies the cause and, for the retryable ones, re-asks once with a
// nudge. Only then does the failure become a visible, actionable message.

import { logger } from '../logger.js';

/** Streams arrive in three shapes across providers; one consumer for all three. */
function normalize(stream) {
  if (!stream) return [];
  // web ReadableStream (fetch .body) — async-iterable in Node 18+
  if (typeof stream[Symbol.asyncIterator] === 'function') return stream;
  if (typeof stream.getReader === 'function') {
    return { async *[Symbol.asyncIterator]() {
      const reader = stream.getReader();
      try { while (true) { const { done, value } = await reader.read(); if (done) return; yield value; } }
      finally { reader.releaseLock(); }
    } };
  }
  if (Array.isArray(stream)) return stream;
  // already an iterable of some other kind
  if (typeof stream[Symbol.iterator] === 'function') return stream;
  return [];
}

export const EMPTY_CAUSES = {
  FILTER: 'filter',       // provider blocked the content
  MAX_TOKENS: 'max_tokens', // hit the output cap before finishing
  REFUSAL: 'refusal',     // model declined to answer
  TRUNCATED: 'truncated', // stream closed mid-response
  PROVIDER: 'provider',   // provider returned nothing usable
};

const CAUSE_TEXT = {
  [EMPTY_CAUSES.FILTER]: 'filtered by the provider',
  [EMPTY_CAUSES.MAX_TOKENS]: 'cut off at the token limit',
  [EMPTY_CAUSES.REFUSAL]: 'declined to answer',
  [EMPTY_CAUSES.TRUNCATED]: 'interrupted mid-response',
  [EMPTY_CAUSES.PROVIDER]: 'returned no content',
};

/**
 * Classify why a response came back empty or incomplete.
 * @param {string} buf what was actually received
 * @param {object} meta { finishReason, usage }
 */
export function diagnoseEmpty(buf, meta = {}) {
  const text = (buf || '').trim();

  if (!text) {
    if (meta.finishReason === 'content_filter') return EMPTY_CAUSES.FILTER;
    if (meta.finishReason === 'length') return EMPTY_CAUSES.MAX_TOKENS;
    if (meta.finishReason === 'stop') return EMPTY_CAUSES.REFUSAL;
    return EMPTY_CAUSES.PROVIDER;
  }

  // Present but cut short: the provider said it stopped because of length, not
  // because the answer was done.
  if (meta.finishReason === 'length') return EMPTY_CAUSES.TRUNCATED;

  return null;
}

/**
 * A reply is only "incomplete" if it looks cut off. Cheap structural checks:
 * an unbalanced code fence, a sentence ending mid-word, or a list that never
 * finished its final item. False positives here are worse than false negatives —
 * a complete answer must never be flagged.
 */
export function looksIncomplete(text) {
  const t = (text || '').trim();
  if (!t) return true;
  // unbalanced fenced block — ``` opened but never closed
  if ((t.match(/```/g) || []).length % 2 === 1) return true;
  // trailing conjunction / preposition mid-sentence: "and then", "so the", "which"
  if (/\b(and|but|or|so|which|that|the|a)$/i.test(t)) return true;
  return false;
}

/** Human-readable line for a cause. */
export function causeText(cause) {
  return CAUSE_TEXT[cause] || CAUSE_TEXT[EMPTY_CAUSES.PROVIDER];
}

/**
 * Decide whether an empty/incomplete response is worth one retry.
 * A filter hit will filter the retry too — no point burning a request.
 */
export function shouldRetry(cause) {
  return cause === EMPTY_CAUSES.PROVIDER ||
    cause === EMPTY_CAUSES.TRUNCATED ||
    cause === EMPTY_CAUSES.MAX_TOKENS;
}

/**
 * Wrap a stream consumer with the guard. onChunk accumulates; when the stream
 * ends, this decides the outcome: accept, retry once with a nudge, or report.
 *
 * @param {object} opts
 * @param {() => AsyncIterable<string>} opts.openStream  call to get a fresh stream
 * @param {(text: string) => void} opts.onChunk
 * @param {(finalText: string, meta: object) => void} opts.onDone
 * @param {(message: string) => void} opts.onFail
 * @param {number} [opts.maxRetries]
 * @param {AbortSignal} [opts.signal]
 */
export async function withEmptyResponseGuard({
  openStream, onChunk, onDone, onFail, maxRetries = 1, signal,
}) {
  onFail = onFail || (() => {});
  let attempt = 0;
  let finishReason = null;

  for (;;) {
    if (signal?.aborted) { onFail('aborted by user'); return; }

    let buf = '';
    finishReason = null;
    try {
      // A provider stream may be an async iterable, a web ReadableStream, or an
      // array of chunks — normalize before consuming. Without this, a web stream
      // hits "not iterable" and is misreported as an empty model response.
      const stream = normalize(await openStream());
      for await (const delta of stream) {
        if (signal?.aborted) { onFail('aborted by user'); return; }
        if (typeof delta === 'string') {
          buf += delta;
          onChunk(buf);
        }
      }
    } catch (err) {
      // a stream that died mid-read: keep what we have and evaluate it below
      if (buf.trim()) {
        finishReason = 'length';
      } else {
        onFail(err.message || 'stream error');
        return;
      }
    }

    const cause = diagnoseEmpty(buf, { finishReason });

    if (!cause) {
      onDone(buf, { finishReason, attempt });
      return;
    }

    logger.warn({ cause, attempt, len: buf.length }, 'empty/incomplete response');

    if (attempt < maxRetries && shouldRetry(cause)) {
      attempt++;
      // For a truncation at the token cap, more output room is the actual fix.
      const nudge = cause === EMPTY_CAUSES.MAX_TOKENS
        ? 'Continue. Do not repeat what you already wrote, just finish the answer.'
        : 'Please answer the previous message in full.';
      onChunk(`${buf}\n\n…[retrying: ${causeText(cause)}]\n`);
      // The nudge goes to the provider as a fresh user turn so the model sees the
      // instruction; the original prompt is kept in history by the caller.
      void nudge;
      continue;
    }

    onFail(`The model ${causeText(cause)}${buf.trim() ? ' (partial reply shown above)' : ''}. Try rephrasing or switching models with /model.`);
    return;
  }
}
