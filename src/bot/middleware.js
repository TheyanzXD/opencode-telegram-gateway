import { config, isAllowed, isAdmin, isAdminChannel } from '../config.js';
import { logger } from '../logger.js';

export function authMiddleware(ctx, next) {
  const u = ctx.from;
  if (!u) return next();
  if (!isAllowed(u.id)) {
    logger.warn({ user: u.id }, 'unauthorized');
    return ctx.reply('🚫 You are not authorized to use this bot.');
  }
  // grammY has no ctx.state — carry flags in ctx.session instead
  if (!ctx.session) ctx.session = {};
  if (isAdmin(u.id)) ctx.session.isAdmin = true;
  if (isAdminChannel(ctx.chat?.id)) ctx.session.isAdminChannel = true;
  if (!ctx.dbUser?.is_banned) return next();
  return ctx.reply('🚫 You are banned.');
}

export function adminOnly(ctx, next) {
  if (!ctx.session?.isAdmin) return ctx.reply('🚫 Admin only.');
  if (!ctx.session?.isAdminChannel) return ctx.reply('🔒 Admin commands are restricted to the configured channel.');
  return next();
}

export function rateLimit(ctx, next) {
  const now = Date.now();
  const last = ctx.session?.lastAt || 0;
  if (now - last < 800) return; // soft throttle
  if (!ctx.session) ctx.session = {};
  ctx.session.lastAt = now;
  return next();
}
