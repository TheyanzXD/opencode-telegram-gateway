// language: JavaScript (Node 18+ ESM), file: src/agent/tools/fs.js
// Tools: read_file, write_file, list_dir, edit_file. write_file and edit_file
// are destructive (they mutate disk) so they go through the approval gate.

import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { z } from 'zod';
import { config } from '../../config.js';

const MAX_READ = 200 * 1024; // 200 KB into context; larger needs an explicit range

function safe(p) {
  const root = config.agent?.workspace || process.cwd();
  const abs = path.resolve(root, p);
  if (!abs.startsWith(root)) {
    return null; // escapes the workspace — refuse instead of throwing
  }
  return abs;
}

const readSchema = z.object({
  path: z.string().min(1),
  start_line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
});
const writeSchema = z.object({ path: z.string().min(1), content: z.string() });
const listSchema = z.object({ path: z.string().optional() });
const editSchema = z.object({
  path: z.string().min(1),
  old: z.string().min(1),
  new: z.string(),
  replace_all: z.boolean().optional(),
});

function range(p, start, end) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: createReadStream(p), crlfDelay: Infinity });
    const out = [];
    let n = 0;
    const from = start ?? 1;
    const to = end ?? Infinity;
    rl.on('line', (line) => {
      n++;
      if (n >= from && n <= to) out.push(`${n}|${line}`);
      if (n > to) rl.close();
    });
    rl.on('close', () => resolve(out.join('\n')));
    rl.on('error', reject);
  });
}

export const fsTools = [
  {
    name: 'read_file',
    description: 'Read a text file. Returns numbered lines. Use start_line/end_line for large files.',
    isDangerous: false,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        start_line: { type: 'number' },
        end_line: { type: 'number' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    schema: readSchema,
    async execute({ path: p, start_line, end_line }) {
      const abs = safe(p);
      if (!abs) return `refused: path escapes the workspace: ${p}`;
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) return `is a directory: ${p}`;
      if (stat.size > MAX_READ && !start_line) {
        return `file is ${stat.size} bytes; specify start_line/end_line to read a window (first 200 lines):\n${await range(abs, 1, 200)}`;
      }
      return range(abs, start_line, end_line);
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with the given content. Destructive — requires approval.',
    isDangerous: true,
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    schema: writeSchema,
    async execute({ path: p, content }) {
      const abs = safe(p);
      if (!abs) return `refused: path escapes the workspace: ${p}`;
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
      return `wrote ${content.length} bytes to ${p}`;
    },
  },
  {
    name: 'edit_file',
    description: 'Replace a string in a file. Fails if the string is not unique (unless replace_all). Destructive.',
    isDangerous: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old: { type: 'string' },
        new: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old', 'new'],
      additionalProperties: false,
    },
    schema: editSchema,
    async execute(args) {
      // `new` is a reserved word in a binding position — read it by key
      const p = args.path;
      const old = args.old;
      const neu = args['new'];
      const replace_all = args.replace_all;
      const abs = safe(p);
      if (!abs) return `refused: path escapes the workspace: ${p}`;
      const text = await fs.readFile(abs, 'utf8');
      const occurrences = text.split(old).length - 1;
      if (occurrences === 0) return `old string not found in ${p}`;
      if (occurrences > 1 && !replace_all) {
        return `old string found ${occurrences} times in ${p} — set replace_all: true or make it unique`;
      }
      const next = replace_all ? text.split(old).join(neu) : text.replace(old, neu);
      await fs.writeFile(abs, next, 'utf8');
      return `replaced ${replace_all ? occurrences : 1} occurrence(s) in ${p}`;
    },
  },
  {
    name: 'list_dir',
    description: 'List files in a directory.',
    isDangerous: false,
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: [],
      additionalProperties: false,
    },
    schema: listSchema,
    async execute({ path: p }) {
      const abs = safe(p ?? '.');
      if (!abs) return `refused: path escapes the workspace: ${p}`;
      const entries = await fs.readdir(abs, { withFileTypes: true });
      return entries
        .map((e) => `${e.isDirectory() ? 'd' : 'f'}  ${e.name}${e.isDirectory() ? '/' : ''}`)
        .join('\n');
    },
  },
];
