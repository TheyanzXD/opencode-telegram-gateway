// language: JavaScript (Node 20+ ESM), file: src/bot/health.js
// Webhook mode, health watchdog, and zero-downtime reload.
//
// Polling is fine for one instance; webhook mode is what lets the bot sit
// behind a TLS terminator and scale horizontally. The watchdog notices when
// the provider stack goes silent — a process that is up but doing nothing is
// a worse failure than a crash, because nothing restarts it.
//
// Zero-downtime reload: SIGHUP clears the provider/config caches so a change
// to providers.yaml or .env takes effect without dropping a connection.

import { config } from '../config.js';
import { logger } from '../logger.js';
import { proxyStatsLog as proxyStats } from '../proxy/pool.js';
import { degradationReport } from '../providers/fallback.js';
import { db } from '../db.js';
import http from 'node:http';

let _startedAt = Date.now();
let _lastActivity = _startedAt;
let _watchTimer = null;

export function touchActivity() { _lastActivity = Date.now(); }

/**
 * A standalone health server, for polling mode.
 *
 * grammy owns the webhook port in webhook mode and does not expose a route for
 * anything else, so in polling mode this binds its own tiny listener. Either
 * way GET /health answers the same JSON.
 *
 * @param {number} port defaults to HEALTH_PORT or 8080
 */
export function startHealthServer(port) {
  const p = Number(port || process.env.HEALTH_PORT || 8080);
  const server = http.createServer(healthHandler);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') logger.warn({ port: p }, 'health port busy — /health unavailable, continuing');
    else logger.warn({ err: err.message }, 'health server error');
  });
  server.listen(p, () => logger.info({ port: p }, 'health endpoint on GET /health'));
  server.unref?.();
  return server;
}

/**
 * Start a webhook server. grammy can drive webhooks directly; this module
 * owns the endpoint and the lifecycle so the caller stays declarative.
 *
 * @param {object} bot grammy Bot instance
 * @param {object} opts { port, path, secretToken, hookUrl }
 */
export async function startWebhook(bot, opts = {}) {
  const port = Number(opts.port || process.env.WEBHOOK_PORT || 8443);
  const path = opts.path || process.env.WEBHOOK_PATH || '/tg';
  const secret = opts.secretToken || process.env.WEBHOOK_SECRET;
  const hookUrl = opts.hookUrl || process.env.WEBHOOK_URL; // https://host/tg

  await bot.start({
    webhook: {
      domain: hookUrl,
      port,
      path,
      secretToken: secret,
      // grammy sets the Telegram webhook itself when domain+path are given
    },
    onStart: (info) => logger.info({ username: info.username, port, path, health: 'GET /health' }, 'webhook online'),
  });
  return { port, path, hookUrl };
}

/**
 * Health check for a load balancer or an orchestrator probe.
 * 200 means the process is alive AND the provider stack answered recently;
 * 503 means alive-but-degraded, which is what a poller should act on.
 */
export function healthStatus() {
  const now = Date.now();
  const silentFor = now - _lastActivity;
  const stale = config.watchdog?.silentMinutes
    ? silentFor > config.watchdog.silentMinutes * 60_000
    : false;
  const degr = degradationReport();
  const broken = degr.filter((d) => !d.available);

  return {
    ok: !stale && !broken.length,
    status: stale || broken.length ? 503 : 200,
    uptime_s: Math.round((now - _startedAt) / 1000),
    silent_for_s: Math.round(silentFor / 1000),
    degraded: broken.map((b) => ({ name: b.name, reason: b.reason })),
  };
}

/** HTTP handler for GET /health — bind it yourself (grammy's webhook owns POST). */
export function healthHandler(req, res) {
  const h = healthStatus();
  res.statusCode = h.status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(h));
}

/**
 * Watchdog: if the bot has gone silent longer than the threshold, log loudly.
 * A scheduler outside the process should restart it; this is the signal.
 */
export function startWatchdog() {
  const minutes = Number(config.watchdog?.silentMinutes || process.env.WATCHDOG_SILENT_MINUTES || 30);
  if (_watchTimer) clearInterval(_watchTimer);
  _watchTimer = setInterval(() => {
    const silent = (Date.now() - _lastActivity) / 60_000;
    if (silent > minutes) {
      logger.error({ silent_min: Math.round(silent), threshold: minutes }, 'WATCHDOG: bot is silent');
    }
  }, 5 * 60_000);
  _watchTimer.unref?.();
}

// --------------------------------------------------------------- zero-downtime reload

const RELOADABLE = ['providers', 'config'];

/**
 * SIGHUP handler. Clears every cache that holds a copy of on-disk config, so
 * the next request reads the current file. No connections are dropped: grammy
 * keeps its polling loop or webhook server across this.
 */
export function installReloadHooks(clearFns = []) {
  process.on('SIGHUP', async () => {
    logger.info({ modules: RELOADABLE }, 'reload: clearing caches');
    try {
      for (const fn of clearFns) await fn();
      _startedAt = Date.now();
      logger.info('reload complete');
    } catch (err) {
      logger.error({ err: err.message }, 'reload failed — running config is unchanged');
    }
  });

  process.on('SIGUSR2', () => {
    // USR2 is the "dump state" signal: write a snapshot, do not reload.
    try {
      const s = proxyStats();
      const snap = {
        at: new Date().toISOString(),
        uptime_s: Math.round((Date.now() - _startedAt) / 1000),
        proxy: s,
        health: healthStatus(),
      };
      logger.info(snap, 'state snapshot');
    } catch (err) {
      logger.warn({ err: err.message }, 'snapshot failed');
    }
  });
}
