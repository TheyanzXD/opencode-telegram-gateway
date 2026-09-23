// language: JavaScript (Node 20+ ESM), file: src/bot/runner.js
// High-concurrency update processing.
//
// Plain bot.start() handles updates one at a time, in arrival order — a slow
// agent turn in chat A stalls a /help in chat B. @grammyjs/runner processes
// updates from DIFFERENT chats in parallel (sink concurrency up to 50) while
// keeping one chat strictly FIFO, so a slow turn cannot block anyone else.
//
// The package is optional. When it is absent the runner degrades to bot.start()
// — the bot still runs, just sequentially — so a missing dev dependency never
// stops a deploy.

import { logger } from '../logger.js';

/**
 * Per-chat serialization middleware, always available.
 *
 * @grammyjs/runner ships one, but it is an optional dependency — without it the
 * fallback still needs per-chat FIFO, so this carries the same contract: updates
 * with the same key are queued and run in order, others run in parallel.
 *
 * @param {(ctx: object) => string|undefined} keyFn chat key; undefined is
 *        never serialized (a chatless update has nothing to race against)
 */
export function sequentialize(keyFn) {
  const queues = new Map();

  return async (ctx, next) => {
    const key = keyFn(ctx);
    if (key === undefined || key === null) return next();

    let chain = queues.get(key);
    if (!chain) {
      chain = Promise.resolve();
      queues.set(key, chain);
    }

    // each update appends itself to its chat's chain; the chain resolves in
    // arrival order no matter when the runner schedules it
    const run = chain.then(() => next(), () => next());
    queues.set(key, run.catch(() => {}));
    return run;
  };
}

/**
 * Start the bot with the concurrent runner when available.
 *
 * @param {import('grammy').Bot} bot
 * @param {object} [opts]
 * @param {number} [opts.concurrency=50] parallel update workers
 * @param {string[]} [opts.allowedUpdates] update types to fetch
 * @returns {Promise<object>} handle with a stop() method
 */
export async function setupConcurrentRunner(bot, opts = {}) {
  const concurrency = Math.max(1, opts.concurrency || 50);
  const allowedUpdates = opts.allowedUpdates || ['message', 'callback_query', 'inline_query', 'edited_message'];

  let runnerApi;
  try {
    // dynamic import: @grammyjs/runner is optional, not a hard dependency
    const mod = await import('@grammyjs/runner');
    const { run, sequentialize } = mod;

    // Per-chat serialization: one chat's updates stay ordered no matter how many
    // workers are pulling. Without this, two messages from one chat could be
    // handled out of order or interleave mid-turn.
    bot.use(
      sequentialize((ctx) => (ctx.chat?.id ? String(ctx.chat.id) : undefined)),
    );

    const runner = run(bot, {
      runner: {
        fetch: { allowed_updates: allowedUpdates, timeout: 30 },
      },
      sink: { concurrency },
    });

    logger.info({ concurrency, mode: 'grammy-runner' }, 'concurrent runner started');
    runnerApi = {
      mode: 'grammy-runner',
      concurrency,
      stop: () => runner.close?.(),
      handle: runner,
    };
  } catch (err) {
    // No @grammyjs/runner installed → sequential polling. Correct behavior, not
    // a failure: the bot still serves every chat, just not in parallel.
    logger.warn(
      { err: err.message, hint: 'npm i @grammyjs/runner for per-chat concurrency' },
      'concurrent runner unavailable — falling back to sequential bot.start()',
    );
    await bot.start({
      allowed_updates: allowedUpdates,
      onStart: (botInfo) => logger.info({ username: botInfo.username }, 'bot online (sequential)'),
    });
    runnerApi = { mode: 'sequential', concurrency: 1, stop: () => bot.stop() };
  }

  return runnerApi;
}
