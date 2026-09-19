#!/usr/bin/env node
// language: JavaScript (Node 20+ ESM), file: scripts/install.js
// First-run setup: deps, providers.yaml, .env from the example, chromium option.
// `npm run setup` (interactive) is the friendly path; this is the scriptable one.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function log(m) { console.log(`• ${m}`); }

function main() {
  log('installing dependencies (this builds better-sqlite3 — takes a minute)');
  execSync('npm install --omit=dev --no-audit --no-fund', { cwd: ROOT, stdio: 'inherit' });

  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) {
    const example = path.join(ROOT, '.env.example');
    fs.copyFileSync(example, envPath);
    log('created .env from .env.example — put your TELEGRAM_BOT_TOKEN in it');
  } else {
    log('.env already exists, leaving it alone');
  }

  const providersPath = path.join(ROOT, 'providers.yaml');
  if (!fs.existsSync(providersPath)) {
    log('providers.yaml missing — see .env.example and README for the format');
  } else {
    log('providers.yaml present');
  }

  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'workspace'), { recursive: true });
  log('created data/ and workspace/');

  const wantBrowser = process.argv.includes('--chromium');
  if (wantBrowser) {
    log('fetching chromium for /browse (~150 MB)');
    execSync('npm run browser install', { cwd: ROOT, stdio: 'inherit' });
  } else {
    log('skip chromium — run `npm run browser install` later, or /browse fetches it on first use');
  }

  log('done. next: set TELEGRAM_BOT_TOKEN in .env, then `npm start`');
}

try { main(); } catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}
