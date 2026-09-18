/**
 * Format a model reply for Telegram Markdown rendering.
 * Telegram MarkdownV2 is strict; we escape and convert basic Markdown
 * elements to safe forms.
 */
export function escapeV2(s) {
  return String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (m) => '\\' + m);
}

export function toTelegramMarkdown(text) {
  if (!text) return '';
  // simple fenced code block
  return text
    .replace(/```([\s\S]*?)```/g, (_, code) => '```' + code.replace(/`/g, '\\`') + '```')
    .slice(0, 4000);
}

export function splitLong(text, max = 4000) {
  if (text.length <= max) return [text];
  const out = [];
  let rest = text;
  while (rest.length > max) {
    out.push(rest.slice(0, max));
    rest = rest.slice(max);
  }
  if (rest) out.push(rest);
  return out;
}
