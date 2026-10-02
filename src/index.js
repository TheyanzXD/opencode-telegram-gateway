import './bootstrap.js'; // sets CAMOUFOX_INSTALL_DIR before camoufox-js is imported anywhere

import { run, shutdown } from './bot/index.js';
import { logger } from './logger.js';
import { db, migrateLegacyPrefs } from './db.js';
import { closeAll as closeAllTenants } from './tenant.js';

process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));
process.on('uncaughtException', (err) => logger.error({ err }, 'uncaughtException'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

async function gracefulShutdown(signal) {
  logger.info({ signal }, 'shutting down');
  try {
    shutdown();
    closeAllTenants();
    db.close();
  } finally {
    process.exit(0);
  }
}

try { migrateLegacyPrefs(); }
catch (err) { logger.error({ err: err.message }, 'legacy prefs migration failed'); }

run().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'fatal');
  process.exit(1);
});

// skills load once at startup; a bad skill is skipped, never fatal
const skillRoot = config.agent.skillRoot || './skills';
const n = loadSkills(skillRoot);
if (n) logger.info({ root: skillRoot, n }, 'skills loaded');
