// language: JavaScript (Node 18+ ESM), file: src/plugins/loader.js
// Plugin loader. A plugin is a directory under ./plugins with an index.js that
// default-exports a plain object:
//
//   export default {
//     name: 'custom-git',
//     tools: [myTool],                 // merged into the agent's tool registry
//     middleware: (bot) => {},         // receives the grammY bot instance
//     onMessage: (ctx) => {},          // every incoming message
//   }
//
// Failures are isolated: one bad plugin logs and is skipped, the rest still
// load, and the bot still starts. An unknown shape is ignored, not fatal.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { logger } from '../logger.js';

const SHAPE = ['name', 'tools', 'middleware', 'onMessage'];

export class PluginLoader {
  constructor({ dir = null, enabled = true } = {}) {
    this.dir = dir || path.join(process.cwd(), 'plugins');
    this.enabled = enabled;
    /** @type {Array<object>} */
    this.loaded = [];
    this.errors = [];
  }

  async loadAll() {
    if (!this.enabled) return [];
    if (!fs.existsSync(this.dir)) return [];

    let entries;
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch (err) {
      this.errors.push({ plugin: '(dir)', message: err.message });
      return [];
    }

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.name.endsWith('.js')) continue;
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      await this.loadOne(path.join(this.dir, entry.name));
    }
    return this.loaded;
  }

  async loadOne(file) {
    try {
      const url = pathToFileURL(
        fs.statSync(file).isDirectory() ? path.join(file, 'index.js') : file,
      ).href;
      const mod = await import(url);
      const plugin = mod.default || mod;
      if (typeof plugin !== 'object' || !plugin.name) {
        throw new Error('a plugin must default-export an object with a `name`');
      }
      const keys = Object.keys(plugin).filter((k) => SHAPE.includes(k));
      this.loaded.push(plugin);
      logger.info({ plugin: plugin.name, hooks: keys }, 'plugin loaded');
    } catch (err) {
      // one broken plugin must not take the bot down
      this.errors.push({ plugin: path.basename(file), message: err.message });
      logger.warn({ plugin: file, err: err.message }, 'plugin failed to load');
    }
  }

  /** All tools from every loaded plugin, for the agent registry. */
  tools() {
    return this.loaded.flatMap((p) => (Array.isArray(p.tools) ? p.tools : []));
  }

  /** Wire plugin middleware onto the bot. */
  async attachMiddleware(bot) {
    for (const p of this.loaded) {
      if (typeof p.middleware === 'function') {
        try {
          p.middleware(bot);
          logger.debug({ plugin: p.name }, 'plugin middleware attached');
        } catch (err) {
          this.errors.push({ plugin: p.name, message: `middleware: ${err.message}` });
        }
      }
    }
  }

  /** Fire onMessage for every loaded plugin. Throwing in one skips the rest. */
  async emitMessage(ctx) {
    for (const p of this.loaded) {
      if (typeof p.onMessage === 'function') {
        try {
          await p.onMessage(ctx);
        } catch (err) {
          this.errors.push({ plugin: p.name, message: `onMessage: ${err.message}` });
        }
      }
    }
  }
}
