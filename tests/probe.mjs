import { register } from 'node:module';
register(new URL('./camoufox-stub.mjs', import.meta.url).href, import.meta.url);
globalThis.__CAMOUFOX_STUB_PAGE = { isClosed: () => false, url: () => 'stub' };
const mod = await import('../src/browser/camoufox.js');
console.log('exports:', Object.keys(mod));
console.log('sessionActive(1):', mod.sessionActive(1));
console.log('getPage(1):', await mod.getPage(1));
