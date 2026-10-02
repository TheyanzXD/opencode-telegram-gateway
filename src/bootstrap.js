// language: JavaScript (Node 20+ ESM), file: src/bootstrap.js
// Runs before anything else imports camoufox-js.
//
// camoufox-js reads CAMOUFOX_INSTALL_DIR at *import* time (module-scope
// INSTALL_DIR), and it defaults to ~/.cache/camoufox. The `camou` CLI installs
// to ~/.cache/camoufox/browsers/official/<version>/ instead. This sets the env
// var from the CLI's own registry so a plain `npx camou install` is enough —
// no manual env, no patched library.
//
// Also skips Playwright's own browser download: this repo ships Camoufox, not
// a stock Chromium, and the addon fetch fails in restricted networks.

import fs from 'node:fs';

const REGISTRY_PATH = '/root/.local/share/camoucli/browsers/registry.json';
const CACHE_ROOT = '/root/.cache/camoufox';

export function bootstrapCamoufox() {
  if (process.env.CAMOUFOX_INSTALL_DIR) return process.env.CAMOUFOX_INSTALL_DIR;
  if (!process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD) {
    process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1';
  }

  let version = null;
  try {
    const reg = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    version = reg.currentVersion || Object.keys(reg.installs || {})[0];
  } catch {
    // camou never installed here — leave the env unset; camoufox-js will say
    // exactly what to run.
    return null;
  }
  if (!version) return null;

  const dir = `${CACHE_ROOT}/browsers/official/${version}`;
  if (!fs.existsSync(`${dir}/camoufox-bin`)) return null;

  // camoufox-js needs version.json next to the binary in its own shape.
  // The camou CLI writes a different one; rewrite it once, keeping a backup.
  try {
    const vpath = `${dir}/version.json`;
    const raw = JSON.parse(fs.readFileSync(vpath, 'utf8'));
    if (!raw.release) {
      const bak = `${dir}/version.camou.json`;
      if (!fs.existsSync(bak)) fs.writeFileSync(bak, JSON.stringify(raw));
      fs.writeFileSync(vpath, JSON.stringify({
        release: raw.release_tag || raw.release_version || raw.version,
        version: (raw.release_version || raw.version || '').split('-')[0],
      }));
    }
  } catch {
    // missing version.json → camoufox-js reports its own error; not fatal here
  }

  process.env.CAMOUFOX_INSTALL_DIR = dir;
  return dir;
}

bootstrapCamoufox();
