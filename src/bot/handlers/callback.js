import { resolveApproval } from '../../agent/approval.js';
import { getUser } from '../../db.js';
import { logger } from '../../logger.js';
import {
  renderProfile, renderRepos, renderGists, revokeToken,
} from '../commands/gitconfig.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { InputFile } from 'grammy';

async function handleGh(ctx, data) {
  const userId = ctx.from?.id;
  if (!userId) return ctx.answerCallbackQuery().catch(() => {});
  const u = getUser(userId);
  if (!u?.gh_token && !data.startsWith('gh:cancel')) {
    await ctx.answerCallbackQuery('no token saved').catch(() => {});
    return ctx.reply('No token saved. /gitconfig <token> first.');
  }
  if (data === 'gh:profile') {
    await ctx.answerCallbackQuery().catch(() => {});
    return renderProfile(ctx, u);
  }
  if (data === 'gh:revoke') {
    await ctx.answerCallbackQuery().catch(() => {});
    return ctx.reply('⚠️ Confirm revoke? This clears your token in the bot.', {
      reply_markup: { inline_keyboard: [[
        { text: '✅ Yes, revoke', callback_data: 'gh:revoke:confirm' },
        { text: '❌ Cancel',     callback_data: 'gh:cancel' },
      ]] },
    });
  }
  if (data === 'gh:revoke:confirm') {
    await ctx.answerCallbackQuery('revoked').catch(() => {});
    return revokeToken(ctx, userId);
  }
  if (data === 'gh:cancel') {
    await ctx.answerCallbackQuery('cancelled').catch(() => {});
    return ctx.reply('Cancelled.');
  }
  if (data === 'gh:back') {
    await ctx.answerCallbackQuery().catch(() => {});
    return renderProfile(ctx, u);
  }
  let m;
  if ((m = data.match(/^gh:repos:(\d+)$/))) {
    await ctx.answerCallbackQuery().catch(() => {});
    return renderRepos(ctx, u, parseInt(m[1], 10));
  }
  if ((m = data.match(/^gh:gists:(\d+)$/))) {
    await ctx.answerCallbackQuery().catch(() => {});
    return renderGists(ctx, u, parseInt(m[1], 10));
  }
  await ctx.answerCallbackQuery().catch(() => {});
}

async function handleSendFile(ctx, data) {
  await ctx.answerCallbackQuery().catch(() => {});
  if (data === 'tool:sendfile:skip') return;
  const m = data.match(/^tool:sendfile:(\d+):(.+)$/);
  if (!m) return;
  const fileUserId = parseInt(m[1], 10);
  if (fileUserId !== ctx.from?.id) {
    return ctx.reply('🚫 Not your file.');
  }
  let abs;
  try { abs = Buffer.from(m[2], 'base64').toString('utf8'); }
  catch { return ctx.reply('❌ Bad path encoding.'); }
  try {
    const buf = await fs.readFile(abs);
    if (buf.length > 49 * 1024 * 1024) {
      return ctx.reply('❌ File too large for Telegram (max 49 MB).');
    }
    await ctx.replyWithDocument(new InputFile(buf, path.basename(abs)));
  } catch (err) {
    logger.warn({ err: err.message, abs }, 'sendfile failed');
    await ctx.reply(`❌ ${err.message}`);
  }
}

export async function onCallback(ctx) {
  const data = ctx.callbackQuery?.data;
  if (!data) return ctx.answerCallbackQuery().catch(() => {});
  if (data.startsWith('tool:')) {
    if (data.startsWith('tool:allow:')) {
      const id = data.slice('tool:allow:'.length);
      const ok = resolveApproval(id, true);
      await ctx.answerCallbackQuery(ok ? 'allowed' : 'no longer pending').catch(() => {});
      return;
    }
    if (data.startsWith('tool:deny:')) {
      const id = data.slice('tool:deny:'.length);
      const ok = resolveApproval(id, false);
      await ctx.answerCallbackQuery(ok ? 'denied' : 'no longer pending').catch(() => {});
      return;
    }
    if (data.startsWith('tool:sendfile:')) return handleSendFile(ctx, data);
  }
  if (data.startsWith('gh:')) return handleGh(ctx, data);
  if (data.startsWith('noop:')) return ctx.answerCallbackQuery().catch(() => {});
  logger.debug({ data }, 'unknown callback_query');
  await ctx.answerCallbackQuery().catch(() => {});
}