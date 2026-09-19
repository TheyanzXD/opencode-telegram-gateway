// language: JavaScript (Node 18+ ESM), file: src/bot/middleware/rate-limit.js
// Sliding-window rate limit per user. grammY middleware — runs after auth.
// Admins are exempt. Limits are generous: this exists to stop a runaway loop or
// a flooding account, not to throttle a normal conversation.

const windows = new Map(); // userId -> array of timestamps
const CLEANUP_EVERY = 5 * 60 * 1000;
let lastCleanup = Date.now();

function prune(now, windowMs) {
  if (now - lastCleanup > CLEANUP_EVERY) {
    for (const [id, ts] of windows) {
      const kept = ts.filter((t) => now - t < windowMs);
      if (kept.length) windows.set(id, kept);
      else windows.delete(id);
    }
    lastCleanup = now;
  }
}

export function rateLimitMiddleware({ maxPerMinute = 30, windowMs = 60_000 } = {}) {
  return (ctx, next) => {
    if (!ctx.from?.id) return next();
    // admins bypass the limit
    if (ctx.session?.isAdmin) return next();

    const now = Date.now();
    prune(now, windowMs);
    const id = ctx.from.id;
    const ts = windows.get(id) || [];
    const recent = ts.filter((t) => now - t < windowMs);
    if (recent.length >= maxPerMinute) {
      return ctx.reply(
        `⏳ Rate limit reached (${maxPerMinute}/min). Wait a moment and try again.`,
      );
    }
    recent.push(now);
    windows.set(id, recent);
    return next();
  };
}
