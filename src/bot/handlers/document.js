// language: JavaScript (Node 20+ ESM), file: src/bot/handlers/document.js
// Document ingestion. A file dropped into the chat becomes part of the agent's
// workspace — that is the Kimi-style long-context feature: the user shares the
// file, the agent reads it, nobody pastes a wall of code.
//
// What is accepted and where it lands:
//   .zip    extracted into the workspace, preserving the tree. A zip is the
//           only realistic way to share a project from a phone.
//   text/*  and code extensions (.js .ts .py .go .rs .md .txt .json .yaml …)
//           saved as-is, one file.
//   images  already handled by the photo path — they go to the vision model,
//           not here.
//
// Rejected: anything else, and anything over the size cap. The cap is not
// stinginess, it is the context window — a 20 MB file the model cannot read
// anyway just wastes disk and the user's turn.

import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import zlib from 'node:zlib';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB — over this, the context window is the limit, not the disk

const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.java',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php', '.swift', '.kt',
  '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.ini', '.sh', '.bash',
  '.sql', '.html', '.css', '.xml', '.env', '.gitignore', '.csv', '.log',
]);

export async function onDocument(ctx, next) {
  const doc = ctx.message?.document;
  if (!doc) return next?.();

  const userId = ctx.from?.id;
  const name = doc.file_name || 'file';
  const ext = path.extname(name).toLowerCase();

  // Images belong to the vision path, not this one.
  if (doc.mime_type?.startsWith('image/')) return next?.();

  if (doc.file_size && doc.file_size > MAX_BYTES) {
    return ctx.reply(
      `⚠️ ${name} is ${(doc.file_size / 1e6).toFixed(1)} MB — over the 8 MB cap.\n\nThe limit is the context window, not the disk. Send a slice, or zip it if it is a project — I extract and read selectively.`,
      { parse_mode: 'Markdown' },
    );
  }

  // Anything we do not recognize is refused with a suggestion, not silently
  // ignored — a dropped file that vanishes is worse than a clear no.
  const isZip = ext === '.zip' || doc.mime_type === 'application/zip';
  const isText = TEXT_EXT.has(ext) || (doc.mime_type?.startsWith('text/') ?? false);
  if (!isZip && !isText) {
    return ctx.reply(
      `I take code and text (.js, .py, .md, .json, …) and .zip archives. \`${name}\` is neither.\n\nIf it is a document, paste the text — if it is a project, zip it first.`,
      { parse_mode: 'Markdown' },
    );
  }

  await ctx.reply(`📥 ${name} — ingesting…`);
  const ws = workspaceRoot(userId);

  try {
    const local = await downloadTo(ctx, doc.file_id);
    if (isZip) {
      const tree = await extractZip(local, path.join(ws, name.replace(/\.zip$/i, '')));
      return ctx.reply(
        `✅ extracted ${tree.count} files to \`workspace/${name.replace(/\.zip$/i, '')}\`\n\n${tree.preview}`,
        { parse_mode: 'Markdown' },
      );
    }
    const dest = path.join(ws, sanitize(name));
    fs.copyFileSync(local, dest);
    const stat = fs.statSync(dest);
    return ctx.reply(
      `✅ saved \`${sanitize(name)}\` (${Math.round(stat.size / 1024)} KB) to the workspace.\n\nAsk me to read, analyze, or run it — it is on my side now.`,
      { parse_mode: 'Markdown' },
    );
  } catch (err) {
    logger.error({ err: err.message, name }, 'document ingestion failed');
    return ctx.reply(`⚠️ could not ingest ${name}: ${err.message}`);
  }
}

// ---------------------------------------------------------------- helpers

function workspaceRoot(userId) {
  const root = path.resolve(config.root, 'workspace', String(userId ?? '0'));
  try { fs.mkdirSync(root, { recursive: true }); } catch {}
  return root;
}

async function downloadTo(ctx, fileId) {
  // Telegram hands us a URL; stream it to the OS tempdir, not the workspace,
  // so a failed download never leaves a half-written file where the agent
  // might read it.
  const url = await ctx.api.getFile(fileId).then((f) =>
    `https://api.telegram.org/file/bot${config.telegram.token}/${f.file_path}`,
  );
  const dest = path.join(tmpdir(), `gw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`telegram file fetch: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return dest;
}

function sanitize(name) {
  // A filename from a stranger is attacker-controlled input. Confine it to a
  // basename — no .., no absolute paths, no separators.
  const base = path.basename(name);
  return base.replace(/[^\w.\-]+/g, '_').slice(0, 200) || 'file';
}
/**
 * Extract a zip into a target dir. Uses the system unzip when available (it
 * handles every compression method), a JS fallback when not.
 *
 * Zip-slip is the attack that matters: an entry named ../../.bashrc must not
 * escape the target. Names are validated BEFORE anything is extracted, so the
 * system unzip — which writes its own files — is only ever handed a zip whose
 * every entry is safe.
 */
async function extractZip(zipPath, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });

  const names = readZipNames(zipPath); // throws if not a zip
  const unsafe = names.filter((n) => !isSafeName(n));
  for (const n of unsafe) logger.warn({ entry: n }, 'zip-slip entry refused');

  // Every entry safe: let the system unzip do the writing. It is faster and
  // handles methods the JS reader does not (zip64, ppmd, encryption).
  if (unsafe.length === 0) {
    try {
      const { spawnSync } = await import('node:child_process');
      const out = spawnSync('unzip', ['-o', '-qq', zipPath, '-d', targetDir], { maxBuffer: 32 * 1024 * 1024 });
      if (out.status === 0) return walkTree(targetDir);
    } catch { /* fall through to the JS reader */ }
  }

  // JS fallback — or the zip holds a hostile entry the system tool would have
  // written before we could stop it. Refuse the bad entries, keep the good.
  const entries = readZipJs(zipPath, targetDir);
  let count = 0;
  const ok = [];

  for (const entry of entries) {
    if (!isSafeName(entry.name)) continue; // already warned
    const resolved = path.resolve(entry.dest);
    if (!resolved.startsWith(path.resolve(targetDir) + path.sep)) continue;
    if (entry.dir) { fs.mkdirSync(resolved, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, entry.data);
    count++;
    ok.push(entry.name);
  }

  const preview = ok.slice(0, 12).map((n) => `- \`${n}\``).join('\n');
  return { count, preview: preview + (ok.length > 12 ? `\n\n…[${ok.length - 12} more]` : '') };
}

/**
 * True when a zip entry name resolves inside the target directory.
 *
 * The trap: path.resolve('/', '../../x') clamps to '/' and hands back 'x', so a
 * naive relative() check reads it as safe. Resolve against a synthetic base
 * instead — a real traversal shows.
 */
function isSafeName(name) {
  if (path.isAbsolute(name)) return false;
  const base = '/__target__';
  const resolved = path.resolve(base, name);
  return resolved === base || resolved.startsWith(base + path.sep);
}

/** Read the central directory and return every entry name. Decompresses nothing. */
function readZipNames(zipPath) {
  const buf = fs.readFileSync(zipPath);
  const eocd = findEocd(buf);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdCount = buf.readUInt16LE(eocd + 10);
  let ptr = cdOffset;
  const names = [];
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    names.push(buf.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8'));
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function findEocd(buf) {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('not a zip file (no end-of-central-directory)');
}

/** Report the files an extractor already wrote to disk. */
function walkTree(targetDir) {
  const names = [];
  (function walk(dir, prefix) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else names.push(rel);
    }
  })(targetDir, '');
  const preview = names.slice(0, 12).map((n) => `- \`${n}\``).join('\n');
  return { count: names.length, preview: preview + (names.length > 12 ? `\n\n…[${names.length - 12} more]` : '') };
}

function readZipJs(zipPath, targetDir) {
  const buf = fs.readFileSync(zipPath);
  const entries = [];
  const eocd = findEocd(buf);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdCount = buf.readUInt16LE(eocd + 10);
  let ptr = cdOffset;

  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const lhOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8');

    // Local header: skip its variable fields to reach the data.
    const lhNameLen = buf.readUInt16LE(lhOffset + 26);
    const lhExtraLen = buf.readUInt16LE(lhOffset + 28);
    const dataStart = lhOffset + 30 + lhNameLen + lhExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`unsupported zip compression (method ${method}) for ${name}`);

    entries.push({ name, dir: name.endsWith('/'), dest: path.join(targetDir, name), data });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
