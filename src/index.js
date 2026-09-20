import './bootstrap.js'; // sets CAMOUFOX_INSTALL_DIR before camoufox-js is imported anywhere

import { run, shutdown } from './bot/index.js';
import { logger } from './logger.js';
import { db } from './db.js';
import { loadSkills } from './agent/skills.js';
import { config } from './config.js';

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

// skills load once at startup; a bad skill is skipped, never fatal
const skillRoot = config.agent.skillRoot || './skills';
const n = loadSkills(skillRoot);
if (n) logger.info({ root: skillRoot, n }, 'skills loaded');
