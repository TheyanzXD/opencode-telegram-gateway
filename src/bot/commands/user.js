import { allModels, providerNames, modelList, getProvider, addModel } from '../../providers/store.js';
import { getUser, setUserModel, setUserTemperature, setUserSystemPrompt, clearHistory, getHistory, getActiveSession } from '../../db.js';
import { listModels } from '../../providers/client.js';
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
  const admin = ctx.session?.isAdmin ? '\n/admin — admin panel (channel-only)' : '';
  await ctx.reply(
`/start — current model + active session
/help — this message
/model [provider/model] — switch model
/model list <provider> — live models from the provider
/model add <provider>/<modelid> [context] [vision] — admin: register a model
/models — list registered models
/temperature <0-2> — set temperature
/system <prompt> — set system prompt
/reset — clear history (active session)
/history — show last messages (active session)
/sessions — conversation sessions${admin}
/memory — the durable facts the agent remembers about you (add/list/clear)
/todo — the agent's task list (what it is doing, what's next)

/agent <task> — tool-calling agent: shell, files, browser, web search
   code tools: execute_python, execute_node, multi_edit, ast_edit, grep, glob
   browser tools: browser_navigate, browser_snapshot (@eN refs),
   browser_click, browser_type, browser_read, browser_search
   tunneling: tunnel_open <port> — your local server gets a clickable URL
   the agent can ask you a question mid-task — tap a button or type back
   destructive tools pause for an approval before running
/abort — cancel the running /agent in this chat
/tools — list every tool the agent can call
/yolo on|off — auto-approve dangerous tools (no keyboard)
/estop — emergency stop: cancel everything now
/debug — last agent run trace for this chat (provider calls, tools, approvals)
/plugins — loaded plugins + failures
/about — version, capabilities, config paths`,
    { parse_mode: 'Markdown' }
  );
}

export async function modelCommand(ctx) {
  const arg = (ctx.match || '').trim();
  const [sub, ...rest] = arg.split(/\s+/);

  // /model add <provider>/<modelid> [context] [vision]
  if (sub === 'add') return modelAdd(ctx, rest.join(' '));
  // /model list <provider> — live /models from the provider itself
  if (sub === 'list') return modelListLive(ctx, rest[0]);

  if (!arg) {
    const u = getUser(ctx.from.id);
    return ctx.reply(
`Current: \`${u?.provider}/${u?.model}\`
Usage: \`/model <provider>/<model>\`

Also:
• \`/model list <provider>\` — fetch the provider's live model list
• \`/model add <provider>/<modelid> [context] [vision]\` — admin: register a model`,
      { parse_mode: 'Markdown' }
    );
  }
  const [provider, ...r] = arg.split('/');
  const model = r.join('/');
  if (!provider || !model) return ctx.reply('Format: /model <provider>/<model>');
  if (!getProvider(provider)) return ctx.reply(`Unknown provider: ${provider}`);
  if (!modelList(provider).find((m) => m.id === model))
    return ctx.reply(`Unknown model ${model} for provider ${provider}. Try \`/model list ${provider}\` to see what the provider offers.`);
  setUserModel(ctx.from.id, provider, model);
  await ctx.reply(`✅ Switched to \`${provider}/${model}\``, { parse_mode: 'Markdown' });
}

async function modelListLive(ctx, providerName) {
  if (!providerName) {
    return ctx.reply('Usage: `/model list <provider>`\nKnown providers: ' + providerNames().join(', '), { parse_mode: 'Markdown' });
  }
  if (!getProvider(providerName)) return ctx.reply(`Unknown provider: ${providerName}`);
  const wait = await ctx.reply(`⏳ Fetching models from ${providerName}…`);
  try {
    const ids = await listModels(providerName, ctx.chat.id);
    if (!ids.length) return ctx.api.editMessageText(ctx.chat.id, wait.message_id, `${providerName} returned no models.`);
    // 4096-char Telegram limit: page through
    const known = new Set(modelList(providerName).map((m) => m.id));
    const lines = ids.slice(0, 400).map((id) => `${known.has(id) ? '✅' : '⬜'} \`${id}\`${known.has(id) ? '' : '  (not registered — use /model add)'}`);
    const header = `*${providerName}* — ${ids.length} model(s):\n\n`;
    for (let i = 0; i < lines.length; i += 90) {
      const chunk = (i === 0 ? header : '') + lines.slice(i, i + 90).join('\n');
      const target = i === 0 ? wait.message_id : undefined;
      if (target) await ctx.api.editMessageText(ctx.chat.id, target, chunk.slice(0, 4000), { parse_mode: 'Markdown' }).catch(() => {});
      else await ctx.reply(chunk.slice(0, 4000), { parse_mode: 'Markdown' }).catch(() => {});
    }
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, wait.message_id, `❌ ${err.message}`.slice(0, 4000)).catch(() => {});
  }
}

async function modelAdd(ctx, raw) {
  if (!ctx.session?.isAdmin) return ctx.reply('🚫 Admin only.');
  const [spec, contextStr, visionStr] = raw.split(/\s+/);
  if (!spec || !spec.includes('/')) return ctx.reply('Usage: `/model add <provider>/<modelid> [context] [vision]`', { parse_mode: 'Markdown' });
  const [provider, ...r] = spec.split('/');
  const modelId = r.join('/');
  if (!getProvider(provider)) return ctx.reply(`Unknown provider: ${provider}. Add it to providers.yaml first.`);
  try {
    addModel(provider, modelId, { context: contextStr, vision: visionStr });
    await ctx.reply(`✅ Registered \`${provider}/${modelId}\`\nNow switch with: \`/model ${provider}/${modelId}\``, { parse_mode: 'Markdown' });
  } catch (err) {
    await ctx.reply(`❌ ${err.message}`);
  }
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
  const model = u?.model ? `${u.provider}/${u.model}` : `${config.defaults.provider}/${config.defaults.model} (default)`;
  let browserLine;
  try {
    const { camoufoxInstalled } = await import('../../browser/camoufox.js');
    browserLine = camoufoxInstalled()
      ? 'Browser: ✅ Camoufox ready (`/agent` + browser_* tools)'
      : 'Browser: ⚠️ Camoufox not installed (`npx camou install`)';
  } catch { browserLine = 'Browser: —'; }
  await ctx.reply(
`🤖 *OpenCode Gateway*
Providers: ${providerNames().length}
Models: ${total}
Default: \`${model}\`
Proxy: ${config.proxy?.enabled ? '✅ on' : '⚠️ off'}
${browserLine}
Agent: ${config.agent?.enabled ? '✅ on (`/agent <task>`)' : '⚠️ off (AGENT_ENABLED)'}
Guardian: ${config.agent?.guardianModel ? '✅ on (approval pre-screen)' : '⚠️ off (GUARDIAN_MODEL)'}
Skills: ${config.agent?.skillRoot ? '✅ on' : '⚠️ off'}
Node ${process.version}`,
    { parse_mode: 'Markdown' }
  );
}
