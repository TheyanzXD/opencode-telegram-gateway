#!/usr/bin/env node
// OpenCode Gateway — CLI entry
import { run as runBot } from '../src/bot/index.js';
import { setup } from '../src/cli/setup.js';
import { doctor } from '../src/cli/doctor.js';
import { tui } from '../src/cli/tui.js';
import { showModels } from '../src/cli/models.js';
import { proxyCmd } from '../src/cli/proxy.js';

const [, , cmd, ...args] = process.argv;
const sub = (cmd || 'start').toLowerCase();

try {
  switch (sub) {
    case 'setup':  await setup(); break;
    case 'doctor': await doctor(); break;
    case 'tui':    await tui(); break;
    case 'models': await showModels(args); break;
    case 'proxy':  await proxyCmd(args); break;
    case 'start':
    default:       await runBot();
  }
} catch (err) {
  console.error('error:', err.message);
  process.exit(1);
}
