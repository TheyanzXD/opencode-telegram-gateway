// language: JavaScript (Node 20+ ESM), file: plugins/custom-git.js
// Example plugin. Demonstrates the full surface: a tool the agent can call,
// a middleware hook, and a message observer. Copy this folder to add your own.

const repoInfo = { lastBranch: null };

export default {
  name: 'custom-git',

  // Tools are merged into the agent's registry and become callable by the model.
  // Shape must match src/tools: name, description, parameters (JSON schema for the
  // LLM), schema (zod for the engine), optional isDangerous, execute.
  tools: [
    {
      name: 'git_status',
      description: 'Show the git status and current branch of a repository.',
      isDangerous: false,
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'subdirectory of the workspace' } },
        required: [],
        additionalProperties: false,
      },
      schema: null, // plugins without zod validate loosely; see execute below
      async execute({ path: p = '.' } = {}) {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const path = await import('node:path');
        const { config } = await import('../src/config.js');
        const root = config.agent?.workspace || process.cwd();
        const abs = path.resolve(root, p);
        if (!abs.startsWith(root)) return 'refused: path escapes the workspace';
        const run = promisify(execFile);
        try {
          const { stdout: branch } = await run('git', ['-C', abs, 'rev-parse', '--abbrev-ref', 'HEAD']);
          const { stdout: status } = await run('git', ['-C', abs, 'status', '--short']);
          repoInfo.lastBranch = branch.trim();
          return `branch: ${branch.trim()}\n${status.trim() || '(clean)'}`;
        } catch (err) {
          return `not a git repo, or git failed: ${err.message}`;
        }
      },
    },
  ],

  // Called once at startup with the grammY bot instance. Register handlers here.
  // Do not throw — a failure here is logged and skipped, other plugins still load.
  middleware(bot) {
    bot.command('branch', async (ctx) => {
      await ctx.reply(repoInfo.lastBranch ? `last branch seen: ${repoInfo.lastBranch}` : 'no repo inspected yet');
    });
  },

  // Called for every message after auth + rate limit, before command routing.
  // Fire-and-forget-ish: awaited, but isolated — a throw does not block the message.
  async onMessage(ctx) {
    if (ctx.message?.text?.startsWith('/git ')) {
      const target = ctx.message.text.slice(5).trim();
      if (!target) return;
      // exercise the tool directly so /git works outside the agent loop
      const tool = this.tools[0];
      const out = await tool.execute({ path: target });
      await ctx.reply(String(out).slice(0, 4000));
    }
  },
};
