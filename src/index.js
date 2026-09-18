import { run, shutdown } from './bot/index.js';
import { logger } from './logger.js';
import { db } from './db.js';

process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));
process.on('uncaughtException', (err) => logger.error({ err }, 'uncaughtException'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

async function gracefulShutdown(signal) {
  logger.info({ signal }, 'shutting down');
  try {
    shutdown();
    db.close();
  } finally {
    process.exit(0);
  }
}

run().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'fatal');
  process.exit(1);
});
