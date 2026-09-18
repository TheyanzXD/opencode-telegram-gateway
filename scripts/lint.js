#!/usr/bin/env node
// Format providers.yaml against the Zod schema. Exits non-zero on mismatch.
import fs from 'node:fs';
import path from 'node:path';
import { loadProviders } from '../src/providers/store.js';

const file = path.join(process.cwd(), 'providers.yaml');
if (!fs.existsSync(file)) {
  console.error(`No providers.yaml in ${process.cwd()}`);
  process.exit(1);
}
try {
  const p = loadProviders();
  console.log(`✓ ${p.length} provider(s) valid`);
  for (const prov of p) {
    console.log(`  - ${prov.name}: ${Object.keys(prov.models).length} model(s)`);
  }
} catch (err) {
  console.error('✗', err.message);
  process.exit(1);
}
