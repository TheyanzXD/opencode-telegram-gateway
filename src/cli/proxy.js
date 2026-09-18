import { refresh } from '../proxy/fetcher.js';
import { proxyStats, pruneProxies } from '../db.js';
import { sweepDead, verifyProxy } from '../proxy/pool.js';
import { config } from '../config.js';

export async function proxyCmd(args) {
  const sub = (args[0] || 'stats').toLowerCase();
  if (sub === 'refresh') {
    const target = parseInt(args[1], 10) || config.proxy.target;
    console.log(`Refreshing proxy pool (target=${target})…`);
    const r = await refresh({ target });
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (sub === 'sweep') {
    console.log('Sweeping dead proxies (random 200 sample)…');
    const r = await sweepDead({});
    console.log(r);
    return;
  }
  if (sub === 'prune') {
    const n = pruneProxies();
    console.log(`Pruned ${n} dead proxies.`);
    return;
  }
  if (sub === 'check') {
    const hostPort = args[1];
    if (!hostPort || !hostPort.includes(':')) {
      console.log('Usage: proxy check <host>:<port> [scheme]');
      return;
    }
    const [host, port] = hostPort.split(':');
    const scheme = args[2] || 'http';
    const ok = await verifyProxy({ scheme, host, port: parseInt(port, 10) });
    console.log(ok ? '✓ alive' : '✗ dead');
    return;
  }
  const s = proxyStats();
  console.log('Proxy pool:');
  console.log(`  total:    ${s.total}`);
  console.log(`  healthy:  ${s.healthy}`);
  console.log(`  dead:     ${s.dead}`);
  console.log(`  target:   ${config.proxy.target}`);
  console.log(`  enabled:  ${config.proxy.enabled}`);
  console.log('\nSubcommands: refresh [target], sweep, prune, check <host>:<port>');
}
