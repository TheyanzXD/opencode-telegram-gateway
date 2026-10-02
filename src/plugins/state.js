// language: JavaScript (Node 18+ ESM), file: src/plugins/state.js
// The loader is created in bot/index.js#run, but the commands need to read it.
// A module-level holder keeps it reachable without passing it through every layer.

let loader = null;

export function setPluginsLoader(l) {
  loader = l;
}

export function pluginsLoader() {
  return loader;
}
