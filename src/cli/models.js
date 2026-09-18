import { allModels, providerNames } from '../providers/store.js';

export async function showModels(args) {
  const filter = args[0];
  const rows = allModels();
  const filtered = filter ? rows.filter((r) => r.provider === filter) : rows;
  if (!filtered.length) {
    console.log(filter ? `No provider '${filter}'. Available: ${providerNames().join(', ')}` : 'No models configured.');
    return;
  }
  const w1 = Math.max(8, ...filtered.map((r) => r.provider.length));
  const w2 = Math.max(8, ...filtered.map((r) => r.id.length));
  console.log('PROVIDER'.padEnd(w1) + '  MODEL'.padEnd(w2) + '  CTX        VISION');
  console.log('-'.repeat(w1 + w2 + 24));
  for (const r of filtered) {
    console.log(
      r.provider.padEnd(w1) + '  ' +
      r.id.padEnd(w2) + '  ' +
      String(r.context || '-').padEnd(10) + ' ' +
      (r.vision ? 'yes' : '-')
    );
  }
  console.log(`\nTotal: ${filtered.length}`);
}
