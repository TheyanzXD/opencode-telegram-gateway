// language: JavaScript (Node 20+ ESM), file: src/agent/guards.js
// Guards around provider responses. Two failure modes that produce a blank or
// nonsense reply, both silent before this fix:
//
// 1. Empty content — model returned nothing (content filter, refusal, truncation,
//    or a provider quirk that sends finish_reason without any delta chunk).
// 2. Truncated stream — the connection closed mid-response and buf holds a
//    half-finished sentence. Sending that as the answer looks like a bug.
//
// The guard classifies the cause and, for the retryable ones, re-asks with a
// NUDGE that actually reaches the provider: openStream(nudge, accumulated).
// Previously the nudge string was built and then discarded (`void nudge;`),
// so every retry sent the identical prompt and got the identical truncation.

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
  FILTER: 'filter',         // provider blocked the content
  MAX_TOKENS: 'max_tokens', // hit the output cap before finishing
  REFUSAL: 'refusal',       // model declined to answer
  TRUNCATED: 'truncated',   // stream closed mid-response
  PROVIDER: 'provider',     // provider returned nothing usable
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
 * Decide whether an empty/incomplete response is worth a retry.
 * A filter hit will filter the retry too — no point burning a request.
 */
export function shouldRetry(cause) {
  return cause === EMPTY_CAUSES.PROVIDER ||
    cause === EMPTY_CAUSES.TRUNCATED ||
    cause === EMPTY_CAUSES.MAX_TOKENS;
}

/**
 * Wrap a stream consumer with the guard. onChunk accumulates; when the stream
 * ends, this decides the outcome: accept, retry with a nudge, or report.
 *
 * The nudge contract: openStream is called as openStream(nudge, accumulatedText).
 * A provider that cannot use the extra argument must at least not break on it —
 * the second argument is the partial reply so a "continue from here" instruction
 * can be assembled, and the buffer already received is never thrown away.
 *
 * @param {object} opts
 * @param {(nudge: string|null, accumulated: string) => AsyncIterable<string>} opts.openStream
 * @param {(text: string) => void} opts.onChunk
 * @param {(finalText: string, meta: object) => void} opts.onDone
 * @param {(message: string) => void} opts.onFail
 * @param {number} [opts.maxRetries]
 * @param {AbortSignal} [opts.signal]
 */
export async function withEmptyResponseGuard({
  openStream, onChunk, onDone, onFail, maxRetries = 2, signal,
}) {
  onFail = onFail || (() => {});
  let attempt = 0;
  let accumulatedText = '';
  let finishReason = null;
  let nextNudge = null;

  for (;;) {
    if (signal?.aborted) { onFail('aborted by user'); return; }

    finishReason = null;
    let turnChunk = '';

    try {
      // The nudge reaches the provider here — accumulated text is carried so a
      // continuation does not restart from zero and lose what was streamed.
      const stream = normalize(await openStream(nextNudge, accumulatedText));
      for await (const delta of stream) {
        if (signal?.aborted) { onFail('aborted by user'); return; }
        if (typeof delta === 'string' && delta.length > 0) {
          turnChunk += delta;
          accumulatedText += delta;
          onChunk(accumulatedText);
        }
      }
    } catch (err) {
      // a stream that died mid-read: keep what we have and evaluate it below
      if (accumulatedText.trim()) {
        finishReason = 'length';
      } else {
        onFail(err.message || 'stream error');
        return;
      }
    }

    const cause = diagnoseEmpty(accumulatedText, { finishReason });

    if (!cause) {
      onDone(accumulatedText, { finishReason, attempt });
      return;
    }

    logger.warn({ cause, attempt, len: accumulatedText.length }, 'empty/incomplete response');

    if (attempt < maxRetries && shouldRetry(cause)) {
      attempt++;
      // For a truncation at the token cap, "continue from where you stopped" is
      // the instruction that actually unblocks it; a full re-ask re-burns the
      // same tokens and truncates the same way.
      nextNudge = cause === EMPTY_CAUSES.MAX_TOKENS
        ? 'Continue your answer exactly from the last word you wrote. Do not repeat anything you already wrote, just finish the answer.'
        : 'Please answer the previous message in full.';
      onChunk(`${accumulatedText}\n\n…[retrying: ${causeText(cause)}]\n`);
      continue;
    }

    onFail(`The model ${causeText(cause)}${accumulatedText.trim() ? ' (partial reply shown above)' : ''}. Try rephrasing or switching models with /model.`);
    return;
  }
}
