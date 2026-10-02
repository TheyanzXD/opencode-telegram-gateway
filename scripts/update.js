#!/usr/bin/env node
// language: JavaScript (Node 20+ ESM), file: scripts/update.js
// Pull, rebuild deps if package.json changed, restart if asked.
// Usage: node scripts/update.js [--restart]
// --restart runs `npm start` after updating; without it, it just refreshes files.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function log(m) { console.log(`• ${m}`); }
function sh(cmd) { execSync(cmd, { cwd: ROOT, stdio: 'inherit' }); }

function main() {
  const restart = process.argv.includes('--restart');

  // snapshot package.json to detect a dep change across the pull
  const before = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');

  log('pulling latest');
  sh('git pull --ff-only');

  const after = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
  if (before !== after) {
    log('package.json changed — reinstalling dependencies');
    sh('npm install --omit=dev --no-audit --no-fund');
  } else {
    log('dependencies unchanged');
  }

  // native module rebuild if the node version moved
  const sqliteDir = path.join(ROOT, 'node_modules', 'better-sqlite3');
  if (fs.existsSync(sqliteDir)) {
    try { sh('npm rebuild better-sqlite3'); } catch { /* will surface at start */ }
  }

  if (restart) {
    log('restarting');
    // assumes a process manager; a bare npm start would block this script
    try { sh('npm start'); } catch (err) { console.error(`✗ restart failed: ${err.message}`); }
  } else {
    log('done — restart the bot yourself to load the new code');
  }
}

try { main(); } catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}
