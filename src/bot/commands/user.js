import { allModels, providerNames, modelList, getProvider } from '../../providers/store.js';
import { getUser, setUserModel, setUserTemperature, setUserSystemPrompt, clearHistory, getHistory, getActiveSession } from '../../db.js';
import { config } from '../../config.js';

export async function startCommand(ctx) {
  const u = getUser(ctx.from.id);
  const a = getActiveSession(ctx.from.id);
  await ctx.reply(
`👋 Welcome to *OpenCode Gateway*!

Your current model:
• Provider: \`${u?.provider ?? config.defaults.provider}\`
• Model: \`${u?.model ?? config.defaults.model}\`
• Temperature: \`${u?.temperature ?? config.defaults.temperature}\`
• Active session: ${a ? `\`${a.name}\`` : '_none_'}

Use /model to switch. /help for full commands.`,
    { parse_mode: 'Markdown' }
  );
}

export async function helpCommand(ctx) {
  const admin = ctx.state.isAdmin ? '\n/admin — admin panel (channel-only)\n/sessions — conversation sessions' : '\n/sessions — conversation sessions';
  await ctx.reply(
`/start — show current model + session
/help — this message
/model [provider/model] — switch model
/models — list available models
/temperature <0-2> — set temperature
/system <prompt> — set system prompt
/reset — clear history (active session)
/history — show last messages (active session)${admin}`,
    { parse_mode: 'Markdown' }
  );
}

export async function modelCommand(ctx) {
  const arg = ctx.match?.trim();
  if (!arg) {
    const u = getUser(ctx.from.id);
    return ctx.reply(
`Current: \`${u?.provider}/${u?.model}\`
Usage: \`/model <provider>/<model>\`\n\nProviders: ${providerNames().join(', ')}`,
      { parse_mode: 'Markdown' }
    );
  }
  const [provider, ...rest] = arg.split('/');
  const model = rest.join('/');
  if (!provider || !model) return ctx.reply('Format: /model <provider>/<model>');
  if (!getProvider(provider)) return ctx.reply(`Unknown provider: ${provider}`);
  if (!modelList(provider).find((m) => m.id === model))
    return ctx.reply(`Unknown model ${model} for provider ${provider}`);
  setUserModel(ctx.from.id, provider, model);
  await ctx.reply(`✅ Switched to \`${provider}/${model}\``, { parse_mode: 'Markdown' });
}

export async function modelsCommand(ctx) {
  const lines = [];
  for (const p of providerNames()) {
    lines.push(`\n*${p}*`);
    for (const m of modelList(p)) {
      const tags = [];
      if (m.vision) tags.push('🖼');
      if (m.context) tags.push(`ctx:${m.context}`);
      lines.push(`  • \`${m.id}\` ${tags.join(' ')}`.trim());
    }
  }
  await ctx.reply(lines.join('\n') || 'No models configured.', { parse_mode: 'Markdown' });
}

export async function temperatureCommand(ctx) {
  const t = parseFloat(ctx.match?.trim() || '');
  if (!Number.isFinite(t) || t < 0 || t > 2) {
    return ctx.reply('Usage: /temperature <0.0-2.0>');
  }
  setUserTemperature(ctx.from.id, t);
  await ctx.reply(`✅ Temperature set to ${t}`);
}

export async function systemCommand(ctx) {
  const prompt = ctx.match?.trim();
  if (!prompt) return ctx.reply('Usage: /system <prompt text>');
  if (prompt.length > 2000) return ctx.reply('System prompt too long (max 2000 chars).');
  setUserSystemPrompt(ctx.from.id, prompt);
  await ctx.reply('✅ System prompt updated.');
}

export async function resetCommand(ctx) {
  const sid = getActiveSession(ctx.from.id)?.id ?? null;
  const n = clearHistory(ctx.from.id, sid);
  await ctx.reply(`🗑 Cleared ${n} message(s) from active session.`);
}

export async function historyCommand(ctx) {
  const sid = getActiveSession(ctx.from.id)?.id ?? null;
  const h = getHistory(ctx.from.id, 10, sid);
  if (!h.length) return ctx.reply('No history in active session.');
  const txt = h
    .map((m) => `[${m.role}] ${m.content.slice(0, 240)}${m.content.length > 240 ? '…' : ''}`)
    .join('\n\n');
  await ctx.reply(txt.slice(0, 4000));
}

export async function aboutCommand(ctx) {
  const total = allModels().length;
  const u = getUser(ctx.from.id);
  await ctx.reply(
`🤖 *OpenCode Gateway*
Providers: ${providerNames().length}
Models: ${total}
Default: \`${u?.provider}/${u?.model}\`
Node ${process.version}`,
    { parse_mode: 'Markdown' }
  );
}
