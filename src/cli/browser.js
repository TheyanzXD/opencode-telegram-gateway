// language: JavaScript (Node 20+ ESM), file: src/cli/browser.js
// `opencode-gateway browser status|install` — operator-side helper for the
// agent's browser tools. The browser is not a chat command anymore: the model
// calls browser_navigate / browser_snapshot / browser_click inside /agent.
// This CLI is the only place an operator needs to check or fetch the binary.

import { spawn } from 'node:child_process';
import { camoufoxInstalled } from '../browser/camoufox.js';

// `camou` owns the install. It downloads Camoufox and its own metadata; the bot
// resolves the same cache at startup (src/bootstrap.js).
function installCamoufox() {
  return new Promise(resolve => {
    const child = spawn('npx', ['camou', 'install'], { stdio: 'inherit' });
    child.on('close', code => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

export async function browserCmd(args) {
  const [sub = 'status'] = args;

  switch (sub.toLowerCase()) {
    case 'status': {
      const ok = camoufoxInstalled();
      console.log(`Camoufox: ${ok ? '✅ installed' : '⚠️  NOT installed'}`);
      console.log('\nThe agent tools browser_navigate / browser_snapshot / browser_click');
      console.log('need this binary. Without it they answer with the install line.');
      if (!ok) console.log('\nRun: opencode-gateway browser install');
      return;
    }

    case 'install': {
      console.log('installing Camoufox via the camou CLI (~150 MB, one-time)...');
      const ok = await installCamoufox();
      if (!ok) { console.error('camou install failed'); process.exit(1); }
      console.log('\n✓ done. The browser_* agent tools are ready.');
      return;
    }

    default:
      console.log(`usage: opencode-gateway browser <status|install>

  status    is Camoufox installed and resolvable?
  install   fetch Camoufox — the one heavy piece (via the camou CLI)

The browser is driven by the agent: /agent "<task>" calls browser_navigate,
browser_snapshot (@eN refs), browser_click, browser_type, browser_read,
browser_search. There is no /browse command.`);
  }
}
