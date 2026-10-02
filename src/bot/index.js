import { Bot, session } from 'grammy';
import { config, assertValid } from '../config.js';
import { logger } from '../logger.js';
import { authMiddleware } from './middleware.js';
import { rateLimitMiddleware } from './middleware/rate-limit.js';
import {
  startCommand, helpCommand, modelCommand, modelsCommand,
  temperatureCommand, systemCommand, resetCommand, historyCommand, aboutCommand,
} from './commands/user.js';
import { adminCommand } from './commands/admin.js';
import { sessionsCommand } from './commands/sessions.js';
import { cwdCommand } from './commands/cwd.js';
import { toolsCommand } from './commands/tools.js';
import { gitconfigCommand } from './commands/gitconfig.js';
import { statsCommand, statsCallback } from './commands/stats.js';
import { onText, onPhoto, onDocument } from './handlers/message.js';
import { onCallback } from './handlers/callback.js';
import { refresh as proxyRefresh } from '../proxy/fetcher.js';
import { sweepDead } from '../proxy/pool.js';
import { loadMcpRegistry, shutdownMcp } from '../mcp/index.js';

let proxyTimer = null;
let activeRunner = null; // grammy runner handle — stopped on shutdown
export let outboundDispatcher = null; // flood-controlled send/edit path
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
  // expose reply context + the active abort controller to handlers
  bot.use(async (ctx, next) => {
    ctx.threads = {
      replyContext: (sid) => replyContext(ctx, sid),
      rememberAnswer, regenKeyboard, stopKeyboard,
      abortControllerFor, releaseAbortController,
    };
    await next();
  });

  // Commands
  bot.command('start', startCommand);
  bot.command('help', helpCommand);
  bot.command('todo', todoCommand);
  bot.command('undo', undoCommand);
  bot.command('model', modelCommand);
  bot.command('models', modelsCommand);
  bot.command('temperature', temperatureCommand);
  bot.command('system', systemCommand);
  bot.command('reset', resetCommand);
  bot.command('history', historyCommand);
  bot.command('about', aboutCommand);
  bot.command('admin', adminCommand);
  bot.command('sessions', sessionsCommand);
  bot.command('cwd', cwdCommand);
  bot.command('tools', toolsCommand);
  bot.command('gitconfig', gitconfigCommand);
  bot.command('stats', statsCommand);

  // Fallbacks
  bot.on('message:text', onText);
  bot.on('message:photo', onPhoto);
  bot.on('message:document', onDocument);
  bot.on('callback_query:data', onCallback);
  bot.callbackQuery(/^stats:/, statsCallback);

  bot.on('inline_query', onInlineQuery);
  bot.on('edited_message', onEditedMessage);

  // Fallbacks
  bot.on('message:text', (ctx, next) => { touchActivity(); return onText(ctx, next); });
  bot.on('message:photo', (ctx, next) => { touchActivity(); return onPhoto(ctx, next); });
  bot.on('message:document', (ctx, next) => { touchActivity(); return onDocument(ctx, next); });

  installReloadHooks([
    () => import('../config.js').then((m) => m.reloadConfig?.()),
    () => import('../providers/store.js').then((m) => m.reloadProviders?.()),
  ]);
  startWatchdog();

  // bot.catch belongs on the instance, not inside the webhook branch — it was
  // unreachable in webhook mode, so an error there became an unhandled rejection
  // instead of a logged, swallowed one.
  bot.catch((err) => {
    logger.error({ err: err.message, ctx: err.ctx?.update?.update_id }, 'bot error');
  });

  expireOldSessions();
  setInterval(() => expireOldSessions(), 6 * 3600 * 1000).unref?.();

  // Outbound webhooks: subscribe external systems to gateway events.
  loadSubscribers(process.env.WEBHOOK_SUBSCRIBERS || '');

  // MCP servers: each connected server contributes agent tools.
  if (process.env.MCP_SERVERS) {
    loadMcpServers(process.env.MCP_SERVERS)
      .then((tools) => logger.info({ tools: tools.length }, 'mcp tools registered'))
      .catch((err) => logger.warn({ err: err.message }, 'mcp load failed'));
  }

  // Pinned turns ride along under the cached prefix on every prompt.
  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (uid) {
      const block = pinnedBlock(uid);
      if (block && ctx.session) ctx.session.pinnedBlock = block;
    }
    await next();
  });

  return bot;
}

/**
 * Start the bot's transport. createBot() stays synchronous — it only builds the
 * instance and wires middleware. Everything actually async (webhook attach,
 * health server) lives here, so `run()` cannot mistake a Promise for a Bot.
 *
 * @param {import('grammy').Bot} bot
 */
export async function startGateway(bot) {
  // drop_pending_updates wipes every unprocessed update. That is an emergency
  // tool (a flood loop or a poisoned queue), not a default: with it always on,
  // any restart during a burst silently destroys user messages.
  const dropPending = /^(1|true|yes|on)$/i.test(String(process.env.DROP_PENDING_UPDATES || ''));

  if (process.env.WEBHOOK_URL || process.env.WEBHOOK_PORT) {
    // webhook + health endpoint on the same port
    const info = await startWebhook(bot, {});
    logger.info(info, 'webhook mode');
    return { mode: 'webhook', info };
  }

  // polling mode: health on its own port so a probe still has something to hit
  if (process.env.HEALTH_PORT !== '0') startHealthServer();

  await bot.api.deleteWebhook({ drop_pending_updates: dropPending });

  // Announce readiness once the transport is actually listening, not when the
  // instance was merely constructed.
  emit('gateway.started', { uptime_target: process.uptime() }).catch(() => {});

  return { mode: 'polling', dropPending };
}

export async function run() {
  const errs = assertValid();
  if (errs.length) {
    for (const e of errs) logger.error(e);
    process.exit(1);
  }
  const bot = createBot();

  // MCP registry startup (non-blocking — failures logged)
  loadMcpRegistry().catch((err) => logger.warn({ err: err.message }, 'mcp load failed'));

  await startProxyMaintenance();

  const webhook = config.webhook;
  const usingWebhook = webhook.enabled && webhook.domain;
  if (!usingWebhook) {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
  } else {
    try {
      await bot.api.setWebhook(`${webhook.domain}${webhook.path}`, {
        secret_token: webhook.secret || undefined,
        allowed_updates: ['message', 'callback_query', 'edited_message'],
      });
      logger.info({ url: `${webhook.domain}${webhook.path}` }, 'webhook configured');
    } catch (err) {
      logger.error({ err: err.message }, 'setWebhook failed');
      process.exit(1);
    }
  }

  logger.info({
    admins: config.telegram.admins,
    allowed: config.telegram.allowed.length,
    proxy_enabled: config.proxy.enabled,
    admin_channel: config.admin.channelId || '(any)',
    webhook: usingWebhook,
    tenant_dir: config.tenants.dir,
  }, 'starting bot');

  bot
    .start({
      onStart: (botInfo) => logger.info({ username: botInfo.username }, 'bot online'),
      webhook: usingWebhook ? {
        domain: webhook.domain,
        port: webhook.port,
        path: webhook.path,
        secretToken: webhook.secret || undefined,
      } : undefined,
    })
    .catch((err) => {
      logger.error({ err: err.message }, usingWebhook ? 'webhook stopped' : 'polling stopped');
      process.exit(1);
    });
}

export function shutdown() {
  if (proxyTimer) clearInterval(proxyTimer);
  shutdownMcp().catch(() => {});
}
