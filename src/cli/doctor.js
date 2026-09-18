import { config, assertValid } from '../config.js';
import { loadProviders, providerNames } from '../providers/store.js';
import { listModels, chatCompletion } from '../providers/client.js';

export async function doctor() {
  console.log('🔎 Diagnosing OpenCode Gateway config…\n');
  let ok = true;

  const envErrs = assertValid();
  if (envErrs.length) {
    ok = false;
    envErrs.forEach((e) => console.error('✗', e));
  } else {
    console.log('✓ .env loaded');
  }

  try {
    const providers = loadProviders();
    console.log(`✓ providers.yaml loaded (${providers.length} providers)`);
    for (const p of providers) {
      const status = p.auth_mode === 'none' || p.api_key ? '✓' : '⚠';
      console.log(`  ${status} ${p.name} [${p.auth_mode}] models=${Object.keys(p.models).length}`);
    }
  } catch (err) {
    ok = false;
    console.error('✗ providers.yaml:', err.message);
    return process.exit(1);
  }

  console.log('\nProbing each provider /models endpoint:');
  for (const name of providerNames()) {
    process.stdout.write(`  ${name}… `);
    try {
      const ids = await listModels(name);
      console.log(`✓ ${ids.length} model(s)`);
    } catch (err) {
      console.log('⚠', err.message.split('\n')[0]);
    }
  }

  console.log('\nSending a minimal prompt to default provider/model:');
  try {
    const { content, usage } = await chatCompletion({
      provider: config.defaults.provider,
      model: config.defaults.model,
      messages: [{ role: 'user', content: 'reply with exactly: pong' }],
      maxTokens: 8,
    });
    console.log(`✓ ${config.defaults.provider}/${config.defaults.model}:`, JSON.stringify(content));
    if (usage) console.log('  usage:', usage);
  } catch (err) {
    ok = false;
    console.error('✗ chat failed:', err.message);
  }

  process.exit(ok ? 0 : 2);
}
