// language: JavaScript (Node 20+ ESM), file: src/agent/tools/read-pro.js
// The oh-my-pi read idea: one path handles files, directories, archives,
// SQLite, PDFs, notebooks, and URLs — instead of one tool per kind.
//
// What we could not port: omp's read-summary and ast_grep ride pi-natives
// (~80k lines of Rust, tree-sitter over 50 grammars). This module does the
// Node-possible subset: archives (.zip/.tar/.tgz/.gz) and SQLite via the
// better-sqlite3 we already depend on. PDFs have no pure-JS text layer here —
// we say so and point at the browser, which can render one.
//
// read_summary is the idea that survives best in pure JS: the outline of a
// file — top-level declarations, section headers — instead of the whole file.
// It is what makes "what is in this file" cheap.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';
import { config } from '../../config.js';
import { resolveInWorkspace } from '../workspace.js';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_LINES = 400;
const ARCHIVE_EXT = new Set(['.zip', '.tar', '.tgz', '.tar.gz', '.gz']);

function ws(userId) {
  return path.resolve(config.agent.workspace, String(userId ?? 0));
}

/** True for archive extensions omp's read treats as a directory. */
function isArchive(name) {
  const n = name.toLowerCase();
  return n.endsWith('.tar.gz') || n.endsWith('.tgz') || ARCHIVE_EXT.has(path.extname(n));
}

/** True when the bytes start with SQLite's magic. */
function isSqlite(abs) {
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    return buf.toString('ascii', 0, 6) === 'SQLite';
  } catch { return false; }
  finally { try { if (fd != null) fs.closeSync(fd); } catch {} }
}

export const readProTools = [
  {
    name: 'read_pro',
    description: 'Read anything from one path: a file, a directory listing, a .zip/.tar/.tgz/.gz archive (as a listing, with optional entry extraction), or a SQLite database (tables, schema, or a query). Smart about type — you do not need to guess which tool a path needs.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path (or absolute inside the workspace)' },
        entry: { type: 'string', description: 'Archive: extract one entry by name. Omit for the listing.' },
        query: { type: 'string', description: 'SQLite: a SELECT query, "tables", or "schema <table>". Omit for the table list.' },
        offset: { type: 'integer', description: 'Line to start reading from (files only)' },
        limit: { type: 'integer', description: 'Max lines to return (default 400)' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async execute({ path: rel, entry, query, offset = 1, limit = MAX_LINES }, ctx = {}) {
      const id = ctx.userId ?? ctx.chatId;
      const root = ws(id);
      const abs = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(root, rel);
      if (abs !== root && !abs.startsWith(root + path.sep)) return '⚠️ outside the workspace';
      if (!fs.existsSync(abs)) return `⚠️ no such path: ${rel}`;

      const st = fs.statSync(abs);

      // Directory → listing, archives included (omp treats an archive like a dir)
      if (st.isDirectory()) {
        return listDir(abs, rel);
      }
      if (st.size > MAX_BYTES) return `⚠️ ${(st.size / 1e6).toFixed(1)} MB — over the ${MAX_BYTES / 1e6} MB read cap. Read a slice with offset/limit, or use read_summary.`;

      if (isArchive(abs.name || rel)) return readArchive(abs, rel, entry);
      if (isSqlite(abs)) return readSqlite(abs, rel, query, limit);
      return readFileText(abs, rel, offset, limit);
    },
  },

  {
    name: 'read_summary',
    description: 'The outline of a file instead of the file: top-level functions, classes, exports, and section headers with line numbers. Cheaper than reading whole — use it to decide whether a file is worth reading in full.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path relative to the workspace' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    async execute({ file }, ctx = {}) {
      const r = resolveInWorkspace(ctx.userId ?? ctx.chatId, file);
      if (!r.ok) return `⚠️ ${r.reason}`;
      if (!fs.existsSync(r.abs)) return `⚠️ no such file: ${file}`;
      const src = fs.readFileSync(r.abs, 'utf8');
      const lines = src.split('\n');
      if (lines.length > 20000) return `⚠️ ${lines.length} lines — too large to outline cheaply. grep a symbol first.`;

      const ext = path.extname(r.abs).toLowerCase();
      const out = [];

      if (['.md', '.markdown', '.txt'].includes(ext)) {
        // Prose: headers are the outline
        lines.forEach((l, i) => {
          if (/^#{1,6}\s/.test(l)) out.push(`L${i + 1} ${l.trim()}`);
        });
        if (!out.length) return `${file}: ${lines.length} lines of prose, no headers.`;
        return `${file} — ${lines.length} lines, ${out.length} section(s):\n\n${out.slice(0, 80).join('\n')}`;
      }

      // Code: declarations and section comments, in document order.
      const decl = /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|def|struct|impl|enum|interface|type|const|let|var|pub\s+fn)\s+([A-Za-z_$][\w$]*)/;
      const section = /^\s*(?:\/\/|#|\*)\s*[-=]{3,}\s*(.+?)\s*[-=]{3,}/;
      lines.forEach((l, i) => {
        const s = section.exec(l);
        if (s) { out.push(`L${i + 1} ── ${s[1]}`); return; }
        const d = decl.exec(l);
        if (d) out.push(`L${i + 1} ${d[1]}${l.includes('(') ? '(' : ''}`);
      });
      if (!out.length) return `${file}: ${lines.length} lines, no top-level declarations found. Probably data or config — read it directly.`;
      return `${file} — ${lines.length} lines, ${out.length} declaration(s):\n\n${out.slice(0, 100).join('\n')}`;
    },
  },
];

// ---------------------------------------------------------------- helpers

function listDir(abs, rel) {
  const ents = fs.readdirSync(abs, { withFileTypes: true })
    .map((e) => ({ name: e.name, dir: e.isDirectory(), size: 0 }))
    .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  for (const e of ents) {
    if (!e.dir) { try { e.size = fs.statSync(path.join(abs, e.name)).size; } catch {} }
  }
  const body = ents.slice(0, 200).map((e) =>
    `- ${e.dir ? '📁' : '📄'} \`${e.name}\`${e.size ? ` _${(e.size / 1024).toFixed(1)} KB_` : ''}`).join('\n');
  return `${rel}/ — ${ents.length} entr${ents.length === 1 ? 'y' : 'ies'}:\n\n${body}${ents.length > 200 ? `\n\n…[${ents.length - 200} more]` : ''}`;
}

function readFileText(abs, rel, offset, limit) {
  const src = fs.readFileSync(abs, 'utf8');
  const lines = src.split('\n');
  const start = Math.max(1, offset) - 1;
  const slice = lines.slice(start, start + Math.max(1, limit));
  const rendered = slice.map((l, i) => `${String(start + i + 1).padStart(5)}| ${l}`).join('\n');
  return `${rel} — ${lines.length} lines (showing ${start + 1}-${Math.min(start + limit, lines.length)}):\n\n\`\`\`\n${rendered}\n\`\`\``;
}

function readArchive(abs, rel, entry) {
  // .gz single-file
  if (rel.toLowerCase().endsWith('.gz') && !rel.toLowerCase().endsWith('.tgz')) {
    if (!entry) return `\`${rel}\` is a gzip file. Pass \`entry\` to decompress (the member name is arbitrary for single-file gz).`;
    try {
      const out = zlib.gunzipSync(fs.readFileSync(abs)).toString('utf8');
      return `\`\`\`\n${out.slice(0, 6000)}\n\`\`\``;
    } catch (err) { return `⚠️ gunzip failed: ${err.message}`; }
  }

  if (!entry) {
    // List the entries
    const names = tarOrZipNames(abs, rel);
    if (!names.length) return `⚠️ could not list ${rel} (unsupported archive or corrupt).`;
    return `${rel} — ${names.length} entr${names.length === 1 ? 'y' : 'ies'}:\n\n${names.slice(0, 150).map((n) => `- \`${n}\``).join('\n')}${names.length > 150 ? `\n\n…[${names.length - 150} more]` : ''}\n\nPass \`entry\` to extract one.`;
  }

  return extractEntry(abs, rel, entry);
}

function tarOrZipNames(abs, rel) {
  const lower = rel.toLowerCase();
  if (lower.endsWith('.zip')) return zipEntries(abs).names;
  if (lower.endsWith('.tar') || lower.endsWith('.tgz') || lower.endsWith('.tar.gz')) return tarEntries(abs).names;
  return [];
}

/** Minimal tar reader: 512-byte headers, name at 0, size at 124 (octal). */
function tarEntries(abs) {
  try {
    const raw = relLow(abs).endsWith('.gz') || relLow(abs).endsWith('.tgz')
      ? zlib.gunzipSync(fs.readFileSync(abs))
      : fs.readFileSync(abs);
    const names = [];
    const files = new Map();
    let off = 0;
    while (off + 512 <= raw.length) {
      const name = raw.toString('utf8', off, off + 100).replace(/\0+$/, '');
      if (!name) break;
      const sizeOct = raw.toString('ascii', off + 124, off + 136).replace(/\0.*$/, '').trim();
      const size = sizeOct ? parseInt(sizeOct, 8) : 0;
      const type = raw[off + 156];
      if (type !== 5 && name !== '././@PaxHeader') names.push(name);
      if (type !== 53 && type !== 5 && size > 0 && size < MAX_BYTES) {
        files.set(name, raw.slice(off + 512, off + 512 + size));
      }
      off += 512 + Math.ceil(size / 512) * 512;
    }
    return { names, files };
  } catch (err) { return { names: [], files: new Map() }; }
}

function relLow(abs) { return abs.toLowerCase(); }

function zipEntries(abs) {
  // Reuse the reader from the document handler shape: central directory walk.
  const buf = fs.readFileSync(abs);
  const names = [];
  const files = new Map();
  try {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65536); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return { names: [], files: new Map() };
    let ptr = buf.readUInt32LE(eocd + 16);
    const count = buf.readUInt16LE(eocd + 10);
    for (let i = 0; i < count; i++) {
      if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
      const method = buf.readUInt16LE(ptr + 10);
      const compSize = buf.readUInt32LE(ptr + 20);
      const nameLen = buf.readUInt16LE(ptr + 28);
      const extraLen = buf.readUInt16LE(ptr + 30);
      const commentLen = buf.readUInt16LE(ptr + 32);
      const lhOff = buf.readUInt32LE(ptr + 42);
      const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8');
      if (!name.endsWith('/')) names.push(name);
      // data for extraction
      const lhNameLen = buf.readUInt16LE(lhOff + 26);
      const lhExtraLen = buf.readUInt16LE(lhOff + 28);
      const dataStart = lhOff + 30 + lhNameLen + lhExtraLen;
      const raw = buf.slice(dataStart, dataStart + compSize);
      let data;
      if (method === 0) data = raw;
      else if (method === 8) { try { data = zlib.inflateRawSync(raw); } catch { data = null; } }
      if (data) files.set(name, data);
      ptr += 46 + nameLen + extraLen + commentLen;
    }
  } catch {}
  return { names, files };
}

function extractEntry(abs, rel, entry) {
  const lower = rel.toLowerCase();
  let files;
  if (lower.endsWith('.zip')) files = zipEntries(abs).files;
  else files = tarEntries(abs).files;
  // exact, then case-insensitive, then suffix
  let buf = files.get(entry);
  if (!buf) { for (const [k, v] of files) if (k.toLowerCase() === entry.toLowerCase()) { buf = v; break; } }
  if (!buf) { for (const [k, v] of files) if (k.endsWith('/' + entry) || k.endsWith(entry)) { buf = v; break; } }
  if (!buf) return `⚠️ no such entry: ${entry}`;
  const text = buf.toString('utf8');
  return `\`${rel}::${entry}\` (${buf.length} bytes):\n\n\`\`\`\n${text.slice(0, 6000)}\n\`\`\``;
}

function readSqlite(abs, rel, query, limit) {
  let d;
  try { d = new Database(abs, { readonly: true }); }
  catch (err) { return `⚠️ cannot open as SQLite: ${err.message}`; }

  try {
    if (!query || query === 'tables') {
      const rows = d.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all();
      if (!rows.length) return `${rel}: no tables.`;
      return `${rel} — ${rows.length} table(s):\n\n${rows.map((r) => `- \`${r.name}\``).join('\n')}\n\nUse \`query: "schema <table>"\` or \`query: "SELECT …"\`.`;
    }
    if (query.startsWith('schema ')) {
      const t = query.slice(7).trim().replace(/['";]/g, '');
      const row = d.prepare(`SELECT sql FROM sqlite_master WHERE type IN ('table','view','index') AND name = ?`).get(t);
      if (!row) return `⚠️ no such table: ${t}`;
      return `\`\`\`sql\n${row.sql}\n\`\`\``;
    }
    // raw query — read-only by construction (we opened readonly)
    const rows = d.prepare(query).all();
    if (!rows.length) return `Query returned no rows.`;
    const keys = Object.keys(rows[0]);
    const cap = Math.min(rows.length, Math.max(1, limit ?? 100));
    const body = rows.slice(0, cap)
      .map((r) => `| ${keys.map((k) => String(r[k] ?? '').slice(0, 80)).join(' | ')} |`).join('\n');
    return `${rows.length} row(s), showing ${cap}:\n\n| ${keys.join(' | ')} |\n| ${keys.map(() => '---').join(' | ')} |\n${body}`;
  } catch (err) {
    return `⚠️ SQLite: ${err.message}`;
  } finally {
    try { d.close(); } catch {}
  }
}
