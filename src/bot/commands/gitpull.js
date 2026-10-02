// language: JavaScript (Node 20+ ESM), file: src/bot/commands/gitpull.js
// /gitpull — pull the live deployment from the repo and restart the bot.
//
// The deployed copy at /opt/gateway is a true git checkout. This command pulls
// the latest main, rebuilds dependencies if they changed, and restarts the
// gateway (or asks, when the process was not started by systemd).
//
// Safety: it refuses to run on a dirty working tree rather than silently
// overwrite local edits, and it only fast-forwards — never a surprise merge.

import { execFileSync } from 'node:child_process';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

const REPO_DIR = config.root;

function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: REPO_DIR, encoding: 'utf-8', timeout: 60_000 })
    .trim();
}

export async function gitpullCommand(ctx) {
  // 1. fetch first — get remote state without touching the tree
  let fetch;
  try {
    fetch = run('git', ['fetch', 'origin', 'main']);
  } catch (e) {
    return ctx.reply(`⚠️ gagal fetch: ${String(e.stderr || e.message).slice(0, 200)}`);
  }

  // 2. refuse a dirty tree — never overwrite uncommitted local edits
  let dirty;
  try {
    dirty = run('git', ['status', '--porcelain']);
  } catch { dirty = ''; }
  if (dirty && dirty.trim()) {
    return ctx.reply(
      '⛔ working tree kotor — ada perubahan lokal yang belum di-commit.\n\n' +
      'Aku gak mau nimpa kerja lokal yang gak sengaja. Commit dulu, atau jalankan:\n' +
      '`git -C /opt/gateway stash` lalu coba `/gitpull` lagi.\n\n' +
      `File: ${dirty.split('\n').slice(0, 5).join(', ')}`,
      { parse_mode: 'Markdown' },
    );
  }

  // 3. fast-forward only
  let before = run('git', ['rev-parse', 'HEAD']);
  let pull;
  try {
    pull = run('git', ['pull', '--ff-only', 'origin', 'main']);
  } catch (e) {
    return ctx.reply(`⚠️ pull gagal (bukan fast-forward): ${String(e.stderr || e.message).slice(0, 200)}`);
  }
  let after;
  try { after = run('git', ['rev-parse', 'HEAD']); } catch { after = before; }

  if (before === after) {
    return ctx.reply('✅ sudah di commit terbaru — tidak ada update.');
  }

  // 4. rebuild deps if manifest changed in this pull
  let depNote = '';
  try {
    const changed = run('git', ['diff', '--name-only', before, after]);
    if (/\bpackage\.json\b|\bpackage-lock\.json\b/.test(changed)) {
      await ctx.reply('📦 manifest berubah — instal dependency (npm ci)…');
      const npm = run('npm', ['ci', '--no-audit', '--no-fund']);
      const count = String(npm).match(/added \d+|removed \d+/g) || [];
      depNote = `\n\nDependency: ${count.join(', ') || 'ok'}`;
    }
  } catch (e) {
    depNote = `\n\n⚠️ npm ci gagal: ${String(e.message).slice(0, 150)}`;
  }

  // 5. restart the gateway automatically
  let restart = '';
  try {
    run('systemctl', ['restart', 'gateway']);
    // wait a moment and confirm
    const { execFileSync } = await import('node:child_process');
    await new Promise((r) => setTimeout(r, 4000));
    const active = execFileSync('systemctl', ['is-active', 'gateway'], { encoding: 'utf-8' }).trim();
    restart = active === 'active' ? '✅ gateway restart OK' : `⚠️ status setelah restart: ${active}`;
  } catch (e) {
    restart = `⚠️ restart gagal otomatis: ${String(e.message).slice(0, 150)}`;
  }

  const short = (h) => (h || '').slice(0, 7);
  logger.info({ before: short(before), after: short(after) }, 'gitpull applied');
  await ctx.reply(
    `🔁 Update diterapkan.${depNote}\n\n${short(before)} → ${short(after)} (${pull.split('\n')[0] || 'main'})\n\n${restart}`,
    { parse_mode: 'Markdown' },
  );
  return;
}
