// language: JavaScript (Node 20+ ESM), file: src/bot/commands/account.js
// /lang and /key — language switch and bring-your-own-key management.
//
// These live outside index.js because they are long enough that inline
// registration made the bot bootstrap unreadable.

import { setLanguage, languageFor, supportedLanguages } from '../features/i18n.js';
import { setKey, getKey, clearKey } from '../../providers/keys.js';

const MD = { parse_mode: 'Markdown' };

export async function langCommand(ctx) {
  const arg = (ctx.match || '').trim().toLowerCase();
  if (!arg) {
    const lines = ['🌐 Your language: **' + languageFor(ctx.from.id) + '**', 'Available: ' + supportedLanguages.join(', ')];
    return ctx.reply(lines.join('\n\n'), MD);
  }
  if (!supportedLanguages.includes(arg)) {
    return ctx.reply('Unknown language. Available: ' + supportedLanguages.join(', '));
  }
  setLanguage(ctx.from.id, arg);
  return ctx.reply('✅ Language set to **' + arg + '**.', MD);
}

const KEY_USAGE = [
  'Usage:',
  '  `/key set <provider> <key> [base_url] [model,model]`',
  '  `/key chain openai:gpt-4o,anthropic:claude-3-5-sonnet`',
  '  `/key clear`',
  '  `/key`',
].join('\n');

export async function keyCommand(ctx) {
  const arg = (ctx.match || '').trim();
  if (!arg) {
    const k = getKey(ctx.from.id);
    if (!k) return ctx.reply(KEY_USAGE, MD);
    const parts = ['Your key: **' + k.provider + '** @ ' + (k.base_url || '(default)')];
    if (k.models?.length) parts.push('Models: ' + k.models.join(', '));
    if (k.chain?.length) parts.push('Chain: ' + k.chain.join(' → '));
    return ctx.reply(parts.join('\n'), MD);
  }
  const sub = arg.split(/\s+/);
  if (sub[0] === 'clear') {
    clearKey(ctx.from.id);
    return ctx.reply('🗑 Your key was removed. Future turns use the shared key.');
  }
  if (sub[0] === 'set') {
    const [, provider, api_key, base_url, models] = sub;
    if (!provider || !api_key) return ctx.reply(KEY_USAGE, MD);
    setKey(ctx.from.id, { provider, api_key, base_url, models });
    return ctx.reply('✅ Key saved. It is never shown again — /key shows its settings, /key clear removes it.');
  }
  if (sub[0] === 'chain') {
    const chain = sub.slice(1).join(',');
    if (!chain) return ctx.reply(KEY_USAGE, MD);
    const k = getKey(ctx.from.id);
    if (!k) return ctx.reply('Set a key first: `/key set <provider> <key>`', MD);
    setKey(ctx.from.id, { ...k, chain });
    return ctx.reply('✅ Fallback chain:\n' + chain.split(',').join('\n'));
  }
  return ctx.reply(KEY_USAGE, MD);
}
