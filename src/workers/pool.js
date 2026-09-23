// language: JavaScript (Node 20+ ESM), file: src/workers/pool.js
// Worker thread pool for CPU-heavy work.
//
// The event loop is what serves Telegram updates. A 200 ms synchronous parse
// inside a handler stalls EVERY chat for 200 ms — under the runner's 50-way
// concurrency that becomes visible as a p99 spike across the whole bot.
//
// Heavy work (AST parsing, big regex, large DOM extraction, local embedding
// math) is shipped to this pool instead. Each worker is a plain node process
// running one task at a time; the pool is sized to the CPU, not to the chat
// count, so the loop stays free.
//
// Tasks are plain JS functions identified by name — the worker side looks them
// up in a registry, so no eval of untrusted strings ever crosses the boundary.

import { Worker } from 'node:worker_threads';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_FILE = path.join(__dirname, 'worker.js');

const DEFAULT_SIZE = Math.max(1, Math.min(8, (os.cpus().length || 2) - 1));

class WorkerPool {
  constructor(size = DEFAULT_SIZE) {
    this.size = size;
    this.workers = [];   // { worker, busy }
    this.queue = [];     // pending tasks
    this.started = false;
  }

  #start() {
    if (this.started) return;
    this.started = true;
    for (let i = 0; i < this.size; i++) {
      const worker = new Worker(WORKER_FILE);
      const entry = { worker, busy: false };
      worker.on('error', (err) => {
        logger.warn({ err: err.message }, 'worker crashed; restarting');
        const idx = this.workers.indexOf(entry);
        if (idx >= 0) this.workers.splice(idx, 1);
        this.started = false;
        this.#start(); // replace it
      });
      this.workers.push(entry);
    }
    logger.info({ size: this.size }, 'worker pool started');
  }

  /** Grab an idle worker, or null when all are busy. */
  #acquire() {
    for (const entry of this.workers) {
      if (!entry.busy) { entry.busy = true; return entry; }
    }
    return null;
  }

  #pump() {
    while (this.queue.length) {
      const entry = this.#acquire();
      if (!entry) break; // everything busy; wait for a worker to finish
      const task = this.queue.shift();
      this.#run(entry, task);
    }
  }

  #run(entry, task) {
    const { worker } = entry;
    const onMessage = (msg) => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      entry.busy = false;
      if (msg?.error) task.reject(new Error(msg.error));
      else task.resolve(msg?.result);
      this.#pump();
    };
    const onError = (err) => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      entry.busy = false;
      task.reject(err);
      this.#pump();
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.postMessage(task.payload);
  }

  /**
   * Run a registered task off the event loop.
   * @param {string} name task name the worker has registered
   * @param {any} payload task argument (structured-cloneable)
   * @param {number} [timeoutMs] reject if the worker does not answer in time
   * @returns {Promise<any>}
   */
  exec(name, payload, { timeoutMs = 30_000 } = {}) {
    this.#start();
    return new Promise((resolve, reject) => {
      const task = { payload: { name, payload }, resolve, reject };
      if (timeoutMs > 0) {
        const timer = setTimeout(() => {
          // remove from queue if still pending; a running worker is abandoned
          const idx = this.queue.indexOf(task);
          if (idx >= 0) this.queue.splice(idx, 1);
          reject(new Error(`worker task "${name}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        task.reject = (err) => { clearTimeout(timer); reject(err); };
        task.resolve = (v) => { clearTimeout(timer); resolve(v); };
      }
      this.queue.push(task);
      this.#pump();
    });
  }
}

export const workerPool = new WorkerPool();
