# Plugins

A plugin extends the bot without touching the core. Drop a `.js` file (or a
folder with `index.js`) into `plugins/` and it loads on the next start.

## Shape

```js
export default {
  name: 'my-plugin',          // required

  // Tools the agent can call during /agent. Same shape as the built-ins:
  // name, description, parameters (JSON schema for the LLM), schema (zod,
  // optional), isDangerous (optional), execute.
  tools: [ /* … */ ],

  // Called once at startup with the grammY bot instance.
  middleware(bot) { /* bot.command('x', …) */ },

  // Called for every message, after auth + rate limit, before command routing.
  async onMessage(ctx) { /* … */ },
};
```

A hook you do not implement is simply absent. A plugin with no `name` is
rejected; a plugin that throws on load is skipped with a warning — the rest
still load and the bot still starts.

## Commands

- `/plugins` — what loaded, and what failed.

## Built-in example

`plugins/custom-git.js` ships as the reference: a `git_status` tool the agent
calls during `/agent`, a `/branch` command via middleware, and a `/git <path>`
observer in `onMessage`.

## Registering plugin tools

Plugin tools are merged into the agent's registry at run time, so the model
discovers them through the same function-calling surface as `execute_bash`.
Zod is optional for plugin tools — without it, arguments pass through
unchecked, so validate inside `execute` if your tool needs it.

A plugin tool that is `isDangerous: true` goes through the same approval gate
as the built-ins.

## Disabling

```bash
# .env
PLUGINS_ENABLED=false
# or point somewhere else
PLUGINS_DIR=/etc/gateway/plugins
```
