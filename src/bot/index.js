import { Bot, session } from 'grammy';
import { config, assertValid } from '../config.js';
import { logger } from '../logger.js';
import { authMiddleware } from './middleware.js';
import {
  startCommand, helpCommand, modelCommand, modelsCommand,
  temperatureCommand, systemCommand, resetCommand, historyCommand, aboutCommand,
} from './commands/user.js';
import { adminCommand } from './commands/admin.js';
import { sessionsCommand } from './commands/sessions.js';
import {
  agentCommand, abortCommand, toolsCommand, approvalCallback,
} from './commands/agent.js';
import { yoloCommand, estopCommand } from './commands/agent-admin.js';
import { debugCommand, pluginsCommand } from './commands/debug.js';
import { pluginsLoader } from '../plugins/state.js';
import { leaseMiddleware } from '../agent/turn-lease.js';
import { browserSafe } from '../browser/tool.js';
import { onText, onPhoto, onDocument } from './handlers/message.js';
import { refresh as proxyRefresh } from '../proxy/fetcher.js';
import { sweepDead } from '../proxy/pool.js';
import { rateLimitMiddleware } from './middleware/rate-limit.js';
import { PluginLoader } from '../plugins/loader.js';

let proxyTimer = null;
async function startProxyMaintenance() {
  if (!config.proxy.enabled) return;
  // Initial refresh if pool is empty
  const { proxyStats } = await import('../db.js');
  const s = proxyStats();
  if (s.total < 100) {
    try {
      await proxyRefresh({ target: config.proxy.target, premiumFile: config.proxy.premiumFile || undefined });
    } catch (err) {
      logger.warn({ err: err.message }, 'initial proxy refresh failed');
    }
  } else {
    logger.info({ total: s.total, healthy: s.healthy }, 'proxy pool already populated');
  }
  const periodMs = Math.max(1, config.proxy.refreshHours) * 3600 * 1000;
  proxyTimer = setInterval(async () => {
    try {
      await proxyRefresh({ target: config.proxy.target, premiumFile: config.proxy.premiumFile || undefined });
    } catch (err) { logger.warn({ err: err.message }, 'scheduled proxy refresh failed'); }
    try { await sweepDead({}); } catch (err) { logger.warn({ err: err.message }, 'proxy sweep failed'); }
  }, periodMs);
}

export function createBot() {
  const bot = new Bot(config.telegram.token);
  bot.use(session({ initial: () => ({}) }));
  bot.use(authMiddleware);
  bot.use(rateLimitMiddleware({
    maxPerMinute: config.agent.rateLimitPerMinute,
    windowMs: 60_000,
  }));
  // typing indicator while a previous turn is still running in this chat
  bot.use(leaseMiddleware());

  // Commands
  bot.command('start', startCommand);
  bot.command('help', helpCommand);
  bot.command('model', modelCommand);
  bot.command('models', modelsCommand);
  bot.command('temperature', temperatureCommand);
  bot.command('system', systemCommand);
  bot.command('reset', resetCommand);
  bot.command('history', historyCommand);
  bot.command('about', aboutCommand);
  bot.command('admin', adminCommand);
  bot.command('sessions', sessionsCommand);

  // Agent — tool-calling loop with HITL approvals
  bot.command('agent', agentCommand);
  bot.command('abort', abortCommand);
  bot.command('tools', toolsCommand);
  bot.command('yolo', yoloCommand);
  bot.command('estop', estopCommand);
  bot.command('debug', debugCommand);
  bot.command('plugins', pluginsCommand);
  bot.callbackQuery(/^approve:/, approvalCallback);
  bot.callbackQuery(/^deny:/, approvalCallback);

  // Browser automation — state persists per chat until /browse close
  bot.command('browse', async (ctx) => {
    const arg = (ctx.match || '').trim();
    if (!arg) return ctx.reply(browserSafe.usageMarkdown(), { parse_mode: 'Markdown' });
    const args = arg.split(/\s+/);
    const reply = await browserSafe(args, { chatId: ctx.chat.id });
    return ctx.reply(reply.slice(0, 4090), { parse_mode: 'Markdown' });
  });

  // Fallbacks
  bot.on('message:text', onText);
  bot.on('message:photo', onPhoto);
  bot.on('message:document', onDocument);

  bot.catch((err) => {
    logger.error({ err: err.message, ctx: err.ctx?.update?.update_id }, 'bot error');
  });

  return bot;
}

export async function run() {
  const errs = assertValid();
  if (errs.length) {
    for (const e of errs) logger.error(e);
    process.exit(1);
  }
  const bot = createBot();
  await bot.api.deleteWebhook({ drop_pending_updates: true });
  await startProxyMaintenance();

  const plugins = new PluginLoader({ dir: config.plugins.dir, enabled: config.plugins.enabled });
  await plugins.loadAll();
  await plugins.attachMiddleware(bot);
  plugins.bot = bot;
  setPluginsLoader(plugins);

  logger.info({
    admins: config.telegram.admins,
    allowed: config.telegram.allowed.length,
    proxy_enabled: config.proxy.enabled,
    admin_channel: config.admin.channelId || '(any)',
    agent_enabled: config.agent.enabled,
    workspace: config.agent.workspace,
    plugins: plugins.loaded.map((p) => p.name),
  }, 'starting bot');
  if (config.agent.enabled) {
    const fs = await import('node:fs');
    fs.mkdirSync(config.agent.workspace, { recursive: true });
  }
  // plugin hooks fire after auth + rate limit, before command routing
  bot.use(async (ctx, next) => {
    if (ctx.has?.('message')) await plugins.emitMessage(ctx);
    return next();
  });
  // bot.start() rejects on 401/409 — without await+catch it becomes an
  // unhandledRejection and the process lingers as a zombie with dead polling.
  bot
    .start({
      onStart: (botInfo) => logger.info({ username: botInfo.username }, 'bot online'),
    })
    .catch((err) => {
      logger.error({ err: err.message }, 'polling stopped');
      process.exit(1);
    });
}

export function shutdown() {
  if (proxyTimer) clearInterval(proxyTimer);
}
