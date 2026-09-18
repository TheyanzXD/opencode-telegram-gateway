import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('config loads defaults', () => {
  process.env.TELEGRAM_BOT_TOKEN = 'abc';
  process.env.DB_PATH = path.join(os.tmpdir(), 'gw-cfg.db');
  return import(`../src/config.js?ts=${Date.now()}-a`).then((m) => {
    assert.equal(m.config.telegram.token, 'abc');
  });
});

test('zod validates providers.yaml', async () => {
  const YAML = (await import('yaml')).default;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-prov-'));
  const yamlPath = path.join(tmp, 'providers.yaml');
  fs.writeFileSync(yamlPath, YAML.stringify({
    providers: [
      { name: 'p1', base_url: 'https://x.test/v1', auth_mode: 'none', models: { m1: { context: 4096 } } },
      { name: 'p2', base_url: 'https://y.test/v1', auth_mode: 'header', key_env: 'X', models: { m2: { vision: true } } },
    ]
  }));
  const { loadProviders } = await import(`../src/providers/store.js?ts=${Date.now()}-b`);
  const p = loadProviders(yamlPath);
  assert.equal(p.length, 2);
  assert.equal(p[0].name, 'p1');
  assert.equal(p[1].models.m2.vision, true);
});

test('zod rejects malformed provider', async () => {
  const YAML = (await import('yaml')).default;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-prov-bad-'));
  const yamlPath = path.join(tmp, 'providers.yaml');
  fs.writeFileSync(yamlPath, YAML.stringify({
    providers: [{ name: 'bad', base_url: 'not-a-url', auth_mode: 'weird' }]
  }));
  const { loadProviders } = await import(`../src/providers/store.js?ts=${Date.now()}-c`);
  assert.throws(() => loadProviders(yamlPath), /Invalid url|Invalid_enum_value|providers.yaml/);
});

