// language: JavaScript (Node 20+ ESM), file: src/agent/xerj.js
// XERJ integration helper: manages daemon lifecycle, auto-indexing,
// passage search, symbol definitions, memory and token gain stats.
// See: https://github.com/xerj-org/xerj

import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { logger } from '../logger.js';
import { config } from '../config.js';

const XERJ_BASE_URL = process.env.XERJ_URL || 'http://127.0.0.1:9200';
const DEFAULT_DATA_DIR = path.resolve(process.cwd(), 'data', 'xerj');

/**
 * Locate the xerj binary on this machine.
 */
export function getXerjBinary() {
  const homeBin = path.join(os.homedir(), '.local', 'bin', 'xerj');
  if (fs.existsSync(homeBin)) return homeBin;
  const sysBin = '/data/data/com.termux/files/usr/bin/xerj';
  if (fs.existsSync(sysBin)) return sysBin;
  return 'xerj';
}

/**
 * Check if XERJ HTTP daemon is currently responding.
 */
export async function isXerjRunning(url = XERJ_BASE_URL) {
  try {
    const res = await fetch(`${url}/`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const json = await res.json();
    return json?.tagline?.includes('Search') || json?.cluster_name === 'xerj';
  } catch {
    return false;
  }
}

/**
 * Ensure XERJ daemon is running; spawn if offline.
 */
export async function ensureXerjDaemon(dataDir = DEFAULT_DATA_DIR) {
  if (await isXerjRunning()) return true;

  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch {}

  const bin = getXerjBinary();
  logger.info({ bin, dataDir }, 'starting xerj daemon in background');

  const child = spawn(bin, ['--insecure', '--data-dir', dataDir], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Poll for readiness up to 6 seconds
  const start = Date.now();
  while (Date.now() - start < 6000) {
    await new Promise((r) => setTimeout(r, 350));
    if (await isXerjRunning()) {
      logger.info('xerj daemon is ready on %s', XERJ_BASE_URL);
      return true;
    }
  }

  throw new Error('Failed to start xerj daemon within 6s');
}

/**
 * Run a xerj CLI command and return stdout/stderr.
 */
function runXerjCli(args, opts = {}) {
  const bin = getXerjBinary();
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        timeout: opts.timeout ?? 60_000,
        cwd: opts.cwd ?? process.cwd(),
        env: { ...process.env, XERJ_URL: XERJ_BASE_URL, XERJ_DISABLE_FEEDBACK: 'true' },
        maxBuffer: 5 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            code: err.code,
            error: (stderr || stdout || err.message).trim(),
            output: stdout.trim(),
          });
        } else {
          resolve({
            ok: true,
            code: 0,
            output: stdout.trim(),
          });
        }
      }
    );
  });
}

/**
 * Auto-index a directory using XERJ.
 */
export async function xerjAutoindex(folder, options = {}) {
  await ensureXerjDaemon();
  const absFolder = path.resolve(process.cwd(), folder);
  const args = ['autoindex', absFolder, '--yes'];
  if (options.prefix) args.push('--prefix', options.prefix);
  if (options.fresh) args.push('--fresh');

  logger.info({ folder: absFolder }, 'xerj: autoindexing');
  const res = await runXerjCli(args, { timeout: 120_000, cwd: absFolder });
  return res;
}

/**
 * Search indexed passages and code using XERJ.
 * Returns ranked passages with file:line citations.
 */
export async function xerjSearch(query, options = {}) {
  await ensureXerjDaemon();
  const args = ['search', query];
  if (options.full) args.push('--full', String(options.full));

  const res = await runXerjCli(args, { timeout: 20_000 });
  return res;
}

/**
 * Go-to-definition lookup for code symbols using XERJ.
 */
export async function xerjDef(symbol) {
  await ensureXerjDaemon();
  const args = ['def', symbol];
  const res = await runXerjCli(args, { timeout: 15_000 });
  return res;
}

/**
 * Query token savings and search stats from XERJ.
 */
export async function xerjGain() {
  await ensureXerjDaemon();
  const res = await runXerjCli(['gain'], { timeout: 10_000 });
  return res;
}

/**
 * Check cluster health and list indexed indices.
 */
export async function xerjStatus() {
  const running = await isXerjRunning();
  if (!running) {
    return { ok: false, running: false, error: 'xerj daemon is not running' };
  }

  try {
    const [healthRes, indicesRes] = await Promise.all([
      fetch(`${XERJ_BASE_URL}/_cluster/health`, { signal: AbortSignal.timeout(2000) }),
      fetch(`${XERJ_BASE_URL}/_cat/indices?format=json`, { signal: AbortSignal.timeout(2000) }),
    ]);

    const health = healthRes.ok ? await healthRes.json() : null;
    const indices = indicesRes.ok ? await indicesRes.json() : [];

    return {
      ok: true,
      running: true,
      url: XERJ_BASE_URL,
      cluster_name: health?.cluster_name || 'xerj',
      status: health?.status || 'green',
      number_of_nodes: health?.number_of_nodes || 1,
      indices: indices.map((idx) => ({
        index: idx.index,
        docs_count: idx['docs.count'] || idx.docs_count,
        store_size: idx['store.size'] || idx.store_size,
      })),
    };
  } catch (err) {
    return { ok: false, running: true, error: err.message };
  }
}
