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
import { onText, onPhoto, onDocument } from './handlers/message.js';
import { refresh as proxyRefresh } from '../proxy/fetcher.js';
import { sweepDead } from '../proxy/pool.js';

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
  logger.info({
    admins: config.telegram.admins,
    allowed: config.telegram.allowed.length,
    proxy_enabled: config.proxy.enabled,
    admin_channel: config.admin.channelId || '(any)',
  }, 'starting bot');
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
