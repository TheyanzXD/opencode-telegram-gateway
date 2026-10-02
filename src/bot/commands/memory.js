// language: JavaScript (Node 20+ ESM), file: src/bot/commands/memory.js
// /memory — the user's durable memory surface. Lists what the agent remembers
// about them, with one-tap forget, plus an optional add. Mirror of the
// Hermes one (MEMORY.md / USER.md) exposed to chat.
//
// Memory is the small set of facts that survive a /reset: who the user is,
// their standing conventions, their environment. It is injected into the
// system prompt every turn (below the cache prefix), so keeping it curated
// matters — a stale fact read as current.

import { remember, forget, recall } from '../../agent/memory.js';
import { ensureUser } from '../../conversation.js';

export async function memoryCommand(ctx) {
  const user = ensureUser(ctx.from);
  const uid = user.user_id;
  const arg = (ctx.match || '').trim();

  // /memory add <fact>  → durable add
  if (/^add\s+/i.test(arg)) {
    const fact = arg.replace(/^add\s+/i, '').trim();
    if (fact.length < 3) return ctx.reply('⚠️ beri fakta yang lebih panjang (min 3 karakter).');
    const ok = remember(uid, fact.slice(0, 300));
    return ctx.reply(ok
      ? `✅ Diingat: _${fact.slice(0, 120)}_`
      : '⚠️ gagal menyimpan — fakta terlalu panjang (>500 char).');
  }

  // /memory forget <text>  → remove facts containing text
  if (/^forget\s+/i.test(arg)) {
    const q = arg.replace(/^forget\s+/i, '').trim();
    const n = forget(uid, q);
    return ctx.reply(n ? `🗑 dihapus ${n} fakta yang berisi "${q}".` : 'Tidak ada yang cocok.');
  }

  // /memory clear → wipe all
  if (/^clear$/i.test(arg)) {
    const rows = recall(uid, 1000);
    for (const f of rows) forget(uid, f);
    return ctx.reply('🧹 semua memori dibersihkan.');
  }

  // default: list
  const facts = recall(uid);
  if (!facts.length) {
    return ctx.reply(
      '*Memori kosong.*\n\nAku ingat fakta yang kamu sebut pakai `/memory add <fakta>` atau yang terdeteksi otomatis ("aku suka X", "aku pakai Y").\n\nGunakan: `/memory add <fakta>` · `/memory forget <teks>` · `/memory clear`',
      { parse_mode: 'Markdown' },
    );
  }
  const lines = facts.map((f, i) => `${i + 1}. ${f}`).join('\n');
  return ctx.reply(
    `*Yang aku ingat tentangmu (${facts.length}):*\n\n${lines}\n\n\`/memory add <fakta>\` tambah · \`/memory forget <teks>\` hapus`,
    { parse_mode: 'Markdown' },
  );
}
