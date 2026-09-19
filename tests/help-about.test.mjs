import { helpCommand, aboutCommand } from '../src/bot/commands/user.js';

const fakeReply = [];
const ctx = (extra = {}) => ({
  from: { id: 7464851361 },
  session: { isAdmin: false },
  reply: (text, opts) => { fakeReply.push(text); return { message_id: 1 }; },
  ...extra,
});

await helpCommand(ctx());
console.log('=== /help ===');
console.log(fakeReply[fakeReply.length - 1]);

fakeReply.length = 0;
await aboutCommand(ctx());
console.log('\n=== /about ===');
console.log(fakeReply[fakeReply.length - 1]);

const text = fakeReply[fakeReply.length - 1];
const issues = [];
if (text.length > 4096) issues.push('too long');
if (/^|\s_(?=\w)/.test(text)) issues.push('unescaped intra-word underscore risk');
// underscore di tengah kata dalam ID model di-backtick, aman
console.log('\nlength:', text.length, '| issues:', issues.length ? issues.join(', ') : 'none');
