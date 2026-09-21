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
import { usageCommand, quotaCommand } from './commands/usage.js';
import { memoryCommand } from './commands/memory.js';
import { gitpullCommand } from './commands/gitpull.js';
import {
  stopCallback, regenCallback, exportConversation,
  replyContext, rememberAnswer, regenKeyboard, stopKeyboard,
  abortControllerFor, releaseAbortController,
  stopPrefix, regenPrefix, expireOldSessions,
} from './features/threads.js';
import { onInlineQuery, onEditedMessage, sessionForTopic } from './features/inline.js';
import { setLanguage, languageFor, supportedLanguages, t } from './features/i18n.js';
import {
  startWebhook, healthHandler, startHealthServer, startWatchdog, installReloadHooks, touchActivity,
} from './health.js';
import { langCommand, keyCommand } from './commands/account.js';
import { soulCommand } from './commands/soul.js';
import { pinCommand, searchCommand } from './commands/search.js';
import { todoCommand } from './commands/todo.js';
import { undoCommand } from './commands/undo.js';
import { answerCallback, answerByText } from '../agent/tools/ask-user.js';
import { loadSubscribers, emit } from './features/webhooks.js';
import { pinnedBlock } from './features/pinned.js';
import { loadMcpServers, allMcpTools } from '../mcp/client.js';
import { setKey, getKey, clearKey, resolvedKeyFor } from '../providers/keys.js';
import { pluginsLoader, setPluginsLoader } from '../plugins/state.js';
import { leaseMiddleware } from '../agent/turn-lease.js';
import { onText, onPhoto } from './handlers/message.js';
import { onDocument } from './handlers/document.js';
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

  // Agent — tool-calling loop with HITL approvals
  bot.command('agent', agentCommand);
  bot.command('abort', abortCommand);
  bot.command('tools', toolsCommand);
  bot.command('yolo', yoloCommand);
  bot.command('estop', estopCommand);
  bot.command('debug', debugCommand);
  bot.command('plugins', pluginsCommand);
  bot.command('usage', usageCommand);
  bot.command('cost', usageCommand);
  bot.command('quota', quotaCommand);
  bot.command('memory', memoryCommand);
  bot.command('gitpull', gitpullCommand);
  bot.command('export', exportConversation);
  bot.command('lang', langCommand);
  bot.command('key', keyCommand);
  bot.command('soul', soulCommand);
  bot.command('pin', pinCommand);
  bot.command('search', searchCommand);
  // account: language switch + bring-your-own-key
  bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery?.data || '';
    if (data.startsWith('answer:')) return answerCallback(ctx);
    // Tool-approval keyboards: both /agent runs and plain-chat tool calls park
    // a deferred promise on approvals.js; tapping ✅/❌ resolves it.
    if (data.startsWith('approve:') || data.startsWith('deny:')) return approvalCallback(ctx);
    return true;
  });

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

  if (process.env.WEBHOOK_URL || process.env.WEBHOOK_PORT) {
    // webhook + health endpoint on the same port
    return startWebhook(bot, {}).then((info) => {
      logger.info(info, 'webhook mode');
      return bot;
    });
  }
  // polling mode: health on its own port so a probe still has something to hit
  if (process.env.HEALTH_PORT !== '0') startHealthServer();

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

  // Announce readiness to any subscribed system.
  emit('gateway.started', { uptime_target: process.uptime() }).catch(() => {});

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
