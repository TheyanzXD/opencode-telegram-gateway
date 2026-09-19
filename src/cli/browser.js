// language: JavaScript (Node 18+), file: src/cli/browser.js
// `opencode-gateway browser status|install|verify` — operator-side helper for
// the /browse chat command. All it does is resolve the binary, run npm, and
// shell out to agent-browser's own install/doctor paths. Never imported by
// the bot itself (the bot imports src/browser/tool.js only).

import { spawn } from 'node:child_process';
import { browserAvailable, browserExec } from '../browser/tool.js';

// Chromium is not bundled — it is the one heavy (~150 MB) piece. The npm
// package is a local dependency already; this fetches its browser binary.
function installChromium() {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['bin/cli.js', 'install', 'chromium'], {
      cwd: new URL('../node_modules/agent-browser', import.meta.url).pathname,
      stdio: 'inherit',
    });
    child.on('close', code => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

export async function browserCmd(args) {
  const [sub = 'status'] = args;

  switch (sub.toLowerCase()) {
    case 'status': {
      const ok = browserAvailable();
      console.log(`agent-browser: ${ok ? 'found' : 'NOT installed'}`);
      if (ok) {
        const r = await browserExec(['--version']);
        console.log(`version:     ${(r.stdout || '').trim() || 'unknown'}`);
      }
      console.log('\n/browse in chat will ' + (ok ? 'work.' : 'reply with install instructions.'));
      if (!ok) console.log('\nRun: opencode-gateway browser install');
      return;
    }

    case 'install': {
      console.log('fetching Chromium (~150 MB, one-time)...');
      const ok = await installChromium();
      if (!ok) { console.error('chromium install failed'); process.exit(1); }
      console.log('\n✓ done. /browse is ready.');
      return;
    }

    case 'verify': {
      if (!browserAvailable()) { console.error('agent-browser not installed'); process.exit(1); }
      const target = args[1] || 'https://example.com';
      console.log(`opening ${target} ...`);
      const r = await browserExec(['open', target], { timeoutMs: 45_000 });
      if (!r.ok) { console.error(r.stderr || 'open failed'); process.exit(1); }
      console.log(r.stdout.trim());
      const t = await browserExec(['read'], { timeoutMs: 30_000 });
      console.log('\n--- page text ---');
      console.log(t.stdout.trim().slice(0, 500));
      await browserExec(['close', '--all']);
      console.log('\n✓ browser verified');
      return;
    }

    default:
      console.log(`usage: opencode-gateway browser <status|install|verify [url]>

  status    is agent-browser resolvable? (local dep, PATH, or AGENT_BROWSER_BIN)
  install   fetch Chromium — the one heavy piece the npm package does not bundle
  verify    open a URL and read it back (default https://example.com)

agent-browser itself is already a dependency of this repo; npm ci installs it.
Chromium needs this one-time fetch.`);
  }
}
