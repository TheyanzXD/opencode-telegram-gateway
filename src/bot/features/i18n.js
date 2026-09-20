// language: JavaScript (Node 20+ ESM), file: src/bot/features/i18n.js
// Multi-language UI strings.
//
// The model can already reply in any language — this layer covers the fixed
// strings the bot itself emits: errors, button labels, command help. Those
// are what make the bot feel untranslated even when the conversation is
// fluent.

const STRINGS = {
  en: {
    'quota.reached': '⛔ Daily token quota reached. Resets at 00:00 UTC.',
    'quota.show': '📊 *Your usage*',
    'stop.label': '⏹ Stop',
    'regen.label': '↻ Regenerate',
    'stopped': '(stopped)',
    'empty': '(no response)',
    'tooLong': (n, max) => `⚠️ Message too long (${n}/${max}).`,
    'edit.note': '_(regenerated from your edited message)_',
    'agent.approve': '✅ Approve',
    'agent.deny': '🚫 Deny',
    'agent.approved': 'Approved ✅',
    'agent.denied': 'Denied 🚫',
    'export.empty': 'Nothing to export — this session is empty.',
    'errors.quota': 'quota',
  },
  id: {
    'quota.reached': '⛔ Kuota token harian habis. Direset pukul 00:00 UTC.',
    'quota.show': '📊 *Pemakaian kamu*',
    'stop.label': '⏹ Henti',
    'regen.label': '↻ Buat ulang',
    'stopped': '(dihentikan)',
    'empty': '(tidak ada balasan)',
    'tooLong': (n, max) => `⚠️ Pesan terlalu panjang (${n}/${max}).`,
    'edit.note': '_(dibuat ulang dari pesan yang kamu edit)_',
    'agent.approve': '�️ Setuju',
    'agent.deny': '🚫 Tolak',
    'agent.approved': 'Disetujui ✅',
    'agent.denied': 'Ditolak 🚫',
    'export.empty': 'Belum ada yang bisa diekspor — sesi ini kosong.',
    'errors.quota': 'kuota',
  },
  es: {
    'quota.reached': '⛔ Cuota diaria de tokens alcanzada. Se reinicia a las 00:00 UTC.',
    'quota.show': '📊 *Tu uso*',
    'stop.label': '⏹ Detener',
    'regen.label': '↻ Regenerar',
    'stopped': '(detenido)',
    'empty': '(sin respuesta)',
    'tooLong': (n, max) => `⚠️ Mensaje demasiado largo (${n}/${max}).`,
    'edit.note': '_(regenerado de tu mensaje editado)_',
    'agent.approve': '✅ Aprobar',
    'agent.deny': '🚫 Denegar',
    'agent.approved': 'Aprobado ✅',
    'agent.denied': 'Denegado 🚫',
    'export.empty': 'Nada que exportar — esta sesión está vacía.',
    'errors.quota': 'cuota',
  },
  ru: {
    'quota.reached': '⛔ Дневной лимит токенов исчерпан. Сброс в 00:00 UTC.',
    'quota.show': '📊 *Ваше использование*',
    'stop.label': '⏹ Стоп',
    'regen.label': '↻ Перегенерировать',
    'stopped': '(остановлено)',
    'empty': '(нет ответа)',
    'tooLong': (n, max) => `⚠️ Сообщение слишком длинное (${n}/${max}).`,
    'edit.note': '_(перегенерировано из изменённого сообщения)_',
    'agent.approve': '✅ Одобрить',
    'agent.deny': '🚫 Отклонить',
    'agent.approved': 'Одобрено ✅',
    'agent.denied': 'Отклонено 🚫',
    'export.empty': 'Нечего экспортировать — сессия пуста.',
    'errors.quota': 'квота',
  },
  ja: {
    'quota.reached': '⛔ 1日分のトークンクォータに達しました。UTC 00:00 にリセットされます。',
    'quota.show': '📊 *使用量*',
    'stop.label': '⏹ 停止',
    'regen.label': '↻ 再生成',
    'stopped': '(停止しました)',
    'empty': '(応答なし)',
    'tooLong': (n, max) => `⚠️ メッセージが長すぎます (${n}/${max})。`,
    'edit.note': '_(編集されたメッセージから再生成)_',
    'agent.approve': '✅ 承認',
    'agent.deny': '🚫 拒否',
    'agent.approved': '承認 ✅',
    'agent.denied': '拒否 🚫',
    'export.empty': 'エクスポートするものがありません — セッションが空です。',
    'errors.quota': 'クォータ',
  },
};

const DEFAULT = 'en';

/** Per-user language, remembered. null = fall back to English. */
const _lang = new Map(); // userId → code

export function setLanguage(userId, code) {
  if (code && STRINGS[code]) _lang.set(userId, code);
  else _lang.delete(userId);
}

export function languageFor(userId) {
  return _lang.get(userId) || DEFAULT;
}

/**
 * Look up a string. Missing keys fall back to English, then to the key itself
 * — a missing translation must never break a turn.
 */
export function t(userId, key, ...args) {
  const code = languageFor(userId);
  const table = STRINGS[code] || STRINGS[DEFAULT];
  const val = table[key] ?? STRINGS[DEFAULT][key] ?? key;
  return typeof val === 'function' ? val(...args) : val;
}

export const supportedLanguages = Object.keys(STRINGS);
