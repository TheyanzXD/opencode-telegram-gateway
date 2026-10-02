// language: JavaScript (Node 20+ ESM), file: src/agent/tools/session-pro.js
// The oh-my-pi session tools: checkpoint/rewind and context_notes.
//
// checkpoint/rewind is the investigation pattern: before a risky or uncertain
// line of work, record the goal and a snapshot of the workspace state. If the
// thread turns out to be wrong, rewind restores the files and hands back the
// findings — the work is not lost, and neither is the lesson about why it did
// not work.
//
// context_notes is a scratchpad that survives in the turn: a place to hold
// "the port is 8099, the user said json only" so it does not need to be
// re-read from three tool results back. It is the notebook omp keeps in the
// session.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

const MAX_NOTES = 12 * 1024;
const MAX_SNAPSHOT_FILES = 200;

function ws(userId) {
  return path.resolve(config.agent.workspace, String(userId ?? 0));
}

function ckDir(userId) {
  const d = path.resolve(ws(userId), '.checkpoints');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function activeCheckpoint(userId) {
  const p = path.join(ckDir(userId), 'active.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function setActive(userId, cp) {
  const p = path.join(ckDir(userId), 'active.json');
  if (!cp) { try { fs.unlinkSync(p); } catch {} return; }
  fs.writeFileSync(p, JSON.stringify(cp));
}

/** Snapshot the files that changed since `since` into a compressed bundle. */
function snapshotChanged(userId, since) {
  const root = ws(userId);
  const out = [];
  (function walk(dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length > MAX_SNAPSHOT_FILES) return;
      if (e.isDirectory()) { if (SKIP.has(e.name)) continue; walk(path.join(dir, e.name)); continue; }
      const p = path.join(dir, e.name);
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs < since) continue;
        if (st.size > 512 * 1024) continue;
        out.push({ rel: path.relative(root, p), data: fs.readFileSync(p), mtime: st.mtimeMs });
      } catch {}
    }
  })(root);
  return out;
}

const SKIP = new Set(['.checkpoints', '.undo', 'node_modules', '.git', 'data']);

export const sessionProTools = [
  {
    name: 'checkpoint',
    description: 'Snapshot the workspace before a risky or uncertain line of work. Records the goal you are pursuing. Pair with rewind: if the thread is wrong, the files come back and your findings do not. Use before a refactor with unknown blast radius, or an experiment you may need to abandon.',
    isDangerous: false,
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'What you are trying to accomplish' },
      },
      required: ['goal'],
      additionalProperties: false,
    },
    async execute({ goal }, ctx = {}) {
      const id = ctx.userId ?? ctx.chatId;
      const existing = activeCheckpoint(id);
      if (existing) return `⚠️ a checkpoint is already active (goal: "${existing.goal}", ${new Date(existing.startedAt).toLocaleTimeString()}). rewind or drop it before making a new one.`;

      const files = snapshotChanged(id, 0); // full snapshot of the workspace
      const bundle = path.join(ckDir(id), `cp-${Date.now()}.bin`);
      const payload = JSON.stringify({ files: files.map((f) => ({ rel: f.rel, mtime: f.mtime })) });
      const bodies = files.map((f) => f.data);
      const sizes = bodies.reduce((a, b) => a + b.length, 0);
      const hdr = Buffer.from(JSON.stringify(files.map((f) => ({ rel: f.rel, len: f.data.length, mtime: f.mtime }))));
      const frame = Buffer.concat([Buffer.alloc(4), hdr, ...bodies]);
      frame.writeUInt32BE(hdr.length, 0);
      fs.writeFileSync(bundle, zlib.gzipSync(frame));

      const cp = { goal, startedAt: new Date().toISOString(), bundle, fileCount: files.length, bytes: sizes };
      setActive(id, cp);
      return `📌 checkpoint set — ${files.length} file(s), ${(sizes / 1024).toFixed(1)} KB.\nGoal: ${goal}\n\nWork freely. \`rewind\` restores these files when you are done.`;
    },
  },

  {
    name: 'rewind',
    description: 'Restore the workspace to the last checkpoint and report what you learned. Use when a line of work was wrong: the files come back to the checkpoint state, and your findings stay in the report so nothing is lost.',
    isDangerous: true,
    requiresApproval: () => true,
    parameters: {
      type: 'object',
      properties: {
        report: { type: 'string', description: 'What you found — survives the rewind' },
        keep_files: { type: 'boolean', description: 'Restore anyway, but do not delete files the checkpoint does not know (default false — unknown files stay)' },
      },
      additionalProperties: false,
    },
    async execute({ report, keep_files = false }, ctx = {}) {
      const id = ctx.userId ?? ctx.chatId;
      const cp = activeCheckpoint(id);
      if (!cp) return '⚠️ no active checkpoint. Use checkpoint first.';

      let restored = 0, kept = 0;
      try {
        const raw = zlib.gunzipSync(fs.readFileSync(cp.bundle));
        const hdrLen = raw.readUInt32BE(0);
        const hdr = JSON.parse(raw.toString('utf8', 4, 4 + hdrLen));
        let off = 4 + hdrLen;
        const seen = new Set();
        for (const h of hdr) {
          const data = raw.slice(off, off + h.len);
          off += h.len;
          const abs = path.resolve(ws(id), h.rel);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, data);
          seen.add(path.resolve(abs));
          restored++;
        }
        // Files created after the checkpoint that the bundle does not know:
        // they stay unless the caller asked to remove them.
        if (!keep_files) {
          const after = snapshotChanged(id, new Date(cp.startedAt).getTime());
          for (const f of after) {
            if (!hdr.some((h) => h.rel === f.rel)) { try { fs.unlinkSync(path.resolve(ws(id), f.rel)); kept++; } catch {} }
          }
        }
        try { fs.unlinkSync(cp.bundle); } catch {}
        setActive(id, null);
      } catch (err) {
        logger.error({ err: err.message }, 'rewind failed');
        return `⚠️ rewind failed: ${err.message}. The checkpoint is still active.`;
      }

      return [
        `↩️ rewound to the checkpoint (${restored} file(s) restored${kept ? `, ${kept} post-checkpoint file(s) removed` : ''}).`,
        '',
        report ? `**Findings**\n\n${report}` : '_no report given_',
      ].join('\n');
    },
  },

  {
    name: 'drop_checkpoint',
    description: 'Clear the active checkpoint without rewinding — the work was right, keep it.',
    isDangerous: false,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_a, ctx = {}) {
      const id = ctx.userId ?? ctx.chatId;
      if (!activeCheckpoint(id)) return 'No active checkpoint.';
      setActive(id, null);
      return '✅ checkpoint cleared — the work stands.';
    },
  },

  {
    name: 'context_notes',
    description: 'A persistent notebook for this conversation: facts, ids, ports, decisions that need to survive across turns but do not belong in a file. Set the full text, or omit it to read. Clear with an empty string.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The new notebook contents (omit to read)' },
      },
      additionalProperties: false,
    },
    async execute({ text }, ctx = {}) {
      const id = ctx.userId ?? ctx.chatId;
      const p = path.join(ckDir(id), 'notes.md');
      if (text === undefined) {
        try { return fs.readFileSync(p, 'utf8'); } catch { return 'The notebook is empty.'; }
      }
      if (!text.trim()) { try { fs.unlinkSync(p); } catch {} return '✅ notebook cleared.'; }
      if (text.length > MAX_NOTES) return `⚠️ ${(text.length / 1024).toFixed(1)} KB — over the ${MAX_NOTES / 1024} KB note cap. This is for facts, not files.`;
      fs.writeFileSync(p, text);
      return `✅ notebook set — ${text.length} chars.`;
    },
  },
];
