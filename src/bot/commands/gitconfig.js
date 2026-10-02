import { setUserGhToken, clearUserGhToken, getUser } from '../../db.js';
import { tokenLooksValid, getViewer, listRepos, listGists } from '../../agent/github.js';
import { logger } from '../../logger.js';

const MASK = (t) => (t ? `${t.slice(0, 4)}…${t.slice(-4)}` : '(none)');

function escMd(s) { return String(s ?? '').replace(/[_*[`]/g, '\\$&'); }

function manageKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📂 My repos',         callback_data: 'gh:repos:1' },
         { text: '📝 My gists',         callback_data: 'gh:gists:1' }],
        [{ text: '🔄 Refresh profile',  callback_data: 'gh:profile' }],
        [{ text: '🗑 Revoke token',     callback_data: 'gh:revoke' }],
      ],
    },
  };
}

function revokeKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Yes, revoke', callback_data: 'gh:revoke:confirm' },
         { text: '❌ Cancel',      callback_data: 'gh:cancel' }],
      ],
    },
  };
}

export async function gitconfigCommand(ctx) {
  const arg = ctx.match?.trim();
  const u = getUser(ctx.from.id);

  // /gitconfig <token>
  if (arg && arg !== 'revoke' && arg !== 'repos' && arg !== 'gists') {
    const token = arg;
    if (!tokenLooksValid(token)) {
      return ctx.reply(
        '❌ Token format looks wrong. Fine-grained PATs look like `github_pat_…`, classic like `ghp_…`.',
        { parse_mode: 'Markdown' }
      );
    }
    try {
      const me = await getViewer(token);
      setUserGhToken(ctx.from.id, token, me.login);
      return ctx.reply(
        `✅ GitHub linked.\n\nLogin: *${escMd(me.login)}*\nName: ${escMd(me.name || '—')}\nPublic repos: *${me.public_repos}*\n\nUse /gitconfig to open the manager. Tokens are stored plain in the bot DB — revoke at https://github.com/settings/tokens when done.`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      logger.warn({ err: err.message }, 'gitconfig: token invalid');
      return ctx.reply(`❌ GitHub rejected the token: ${escMd(err.message)}`);
    }
  }

  // /gitconfig revoke
  if (arg === 'revoke') {
    if (!u?.gh_token) return ctx.reply('No GitHub token saved.');
    await ctx.reply('⚠️ Revoke the saved GitHub token for this bot?', revokeKeyboard());
    return;
  }

  // /gitconfig repos
  if (arg === 'repos') return renderRepos(ctx, u, 1);
  // /gitconfig gists
  if (arg === 'gists') return renderGists(ctx, u, 1);

  // /gitconfig (default) — manage menu or setup prompt
  if (!u?.gh_token) {
    return ctx.reply(
      '🐙 *GitHub account manager*\n\nNo token saved yet.\n\nSet one with:\n`/gitconfig <token>`\n\nGet a token at https://github.com/settings/tokens (needs `repo`, `gist`, `read:user`).',
      { parse_mode: 'Markdown' }
    );
  }
  return renderProfile(ctx, u);
}

export async function renderProfile(ctx, u) {
  try {
    const me = await getViewer(u.gh_token);
    const txt =
`🐙 *${escMd(me.login)}*
${escMd(me.name || '')}
${escMd(me.bio || '')}

📍 ${escMd(me.location || '—')}
🔗 ${escMd(me.html_url)}

📦 ${me.public_repos} public • ${me.private_repos ?? '?'} private
👥 ${me.followers} followers • ${me.following} following

Token: \`${MASK(u.gh_token)}\`
(Tap a button below.)`;
    return ctx.reply(txt, { parse_mode: 'Markdown', ...manageKeyboard() });
  } catch (err) {
    logger.warn({ err: err.message }, 'gitconfig: profile fetch failed');
    return ctx.reply(`⚠️ Saved token failed GitHub auth: ${escMd(err.message)}\nRe-link with \`/gitconfig <new_token>\`.`, { parse_mode: 'Markdown' });
  }
}

function paginateKeyboard(verb, page) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '◀ Prev', callback_data: `gh:${verb}:${page - 1}` },
         { text: `Page ${page}`, callback_data: 'noop:' },
         { text: 'Next ▶', callback_data: `gh:${verb}:${page + 1}` }],
        [{ text: '↩ Back', callback_data: 'gh:back' }],
      ],
    },
  };
}

export async function renderRepos(ctx, u, page = 1) {
  if (!u?.gh_token) return ctx.reply('No token saved. /gitconfig <token> first.');
  try {
    const repos = await listRepos(u.gh_token, { per_page: 8, page });
    if (!repos.length) return ctx.reply('No repos found.', paginateKeyboard('repos', page));
    const lines = repos.map((r, i) =>
      `${i + 1}. [${escMd(r.full_name)}](${r.html_url}) ${r.fork ? '⑂' : ''}\n   ⭐ ${r.stargazers_count} • ${escMd(r.language || '—')} • ${r.private ? '🔒' : '🌐'}`
    );
    await ctx.reply(`📂 *Your repos (page ${page})*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown', ...paginateKeyboard('repos', page) });
  } catch (err) {
    logger.warn({ err: err.message, page }, 'gitconfig: listRepos failed');
    await ctx.reply(`⚠️ ${escMd(err.message)}`);
  }
}

export async function renderGists(ctx, u, page = 1) {
  if (!u?.gh_token) return ctx.reply('No token saved. /gitconfig <token> first.');
  try {
    const gists = await listGists(u.gh_token, { per_page: 8, page });
    if (!gists.length) return ctx.reply('No gists found.', paginateKeyboard('gists', page));
    const lines = gists.map((g, i) => `${i + 1}. ${escMd(g.description || '(untitled)')}\n   ${escMd(g.html_url)}`);
    await ctx.reply(`📝 *Your gists (page ${page})*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown', ...paginateKeyboard('gists', page) });
  } catch (err) {
    logger.warn({ err: err.message, page }, 'gitconfig: listGists failed');
    await ctx.reply(`⚠️ ${escMd(err.message)}`);
  }
}

export async function revokeToken(ctx, user_id) {
  clearUserGhToken(user_id);
  await ctx.reply('🗑 GitHub token revoked. Use `/gitconfig <token>` to re-link.');
}

export { MASK };