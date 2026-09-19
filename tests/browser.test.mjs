import { browserSafe, browserAvailable } from '../src/browser/tool.js';

const cid = 11;
console.log('available:', browserAvailable());
console.log('open:', String(await browserSafe(['open','https://news.ycombinator.com'], {chatId:cid})).slice(0,60));
const s = String(await browserSafe(['snapshot'], {chatId:cid}));
const lines = s.split('\n');
console.log('snapshot elements:', lines.length - 1);
console.log('sample:', lines.slice(1,5).join(' | ').slice(0,200));
console.log('get url:', String(await browserSafe(['url'], {chatId:cid})).slice(0,90));
const c = String(await browserSafe(['click','@e103'], {chatId:cid})).slice(0,120);
console.log('click @e103 (new):', c);
console.log('close:', String(await browserSafe(['close'], {chatId:cid})).slice(0,50));
console.log('ALL PASS');
