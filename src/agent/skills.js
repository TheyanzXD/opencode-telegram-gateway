// language: JavaScript (Node 20+ ESM), file: src/agent/skills.js
// Skill loader — markdown knowledge files injected into the system prompt only
// when the turn matches a skill.
//
// Not executed code. A skill is a directory with SKILL.md + frontmatter
// (name, description, when, version). At load time the loader reads every skill
// once and builds an index. Each turn, the turn text is matched against the
// skill descriptions; matches are appended to the system prompt below the
// cached prefix, so adding or removing a skill never invalidates the prefix.
//
// Authoring standards (same rules Hermes enforces by test):
// - description: one sentence, <= 60 chars, ends with a period, no marketing words
// - name: lowercase, hyphens only
// A skill that fails validation is skipped with a warning, never crashes.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../logger.js';

const SKILL_FILE = 'SKILL.md';
const MAX_DESC = 60;
const MARKETING_WORDS = ['amazing', 'powerful', 'best', 'ultimate', 'revolutionary', 'cutting-edge', 'seamless'];

/** @type {Map<string, {name, description, when, version, body}>} */
const index = new Map();

/** Parse a YAML-ish frontmatter block. Deliberately small: no dependency. */
function parseFrontmatter(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (kv) meta[kv[1].trim()] = kv[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return { meta, body: m[2] };
}

function validate(name, meta) {
  const problems = [];
  if (!/^[a-z0-9-]+$/.test(name || '')) problems.push('name must be lowercase hyphenated');
  const desc = meta.description || '';
  if (!desc) problems.push('missing description');
  else {
    if (desc.length > MAX_DESC) problems.push(`description ${desc.length} > ${MAX_DESC} chars`);
    if (!/[.]$/.test(desc)) problems.push('description must end with a period');
    const hit = MARKETING_WORDS.find((w) => desc.toLowerCase().includes(w));
    if (hit) problems.push(`marketing word "${hit}"`);
  }
  return problems;
}

/**
 * Scan a skills directory. Each direct child is either a directory containing
 * SKILL.md, or a top-level SKILL.md. Subdirectories one level deep are also
 * scanned, mirroring the category/<skill> layout.
 */
export function loadSkills(root) {
  index.clear();
  if (!existsSync(root)) return 0;
  let count = 0;

  const scan = (dir, depth = 0) => {
    if (depth > 1) return; // categories/<skill>, no deeper
    let entries;
    try {
      entries = readdirSync(dir);
    } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry);
      let st;
      try { st = statSync(path); } catch { continue; }
      if (st.isDirectory()) { scan(path, depth + 1); continue; }
      if (entry !== SKILL_FILE) continue;

      const raw = readFileSync(path, 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      const dirName = dir.split(/[/\\]/).pop();
      const name = meta.name || dirName;
      const problems = validate(name, meta);
      if (problems.length) {
        logger.warn({ skill: name, problems }, 'skill rejected — authoring standards');
        continue;
      }
      index.set(name, { name, description: meta.description, when: meta.when || '', version: meta.version || '1.0', body });
      count++;
    }
  };

  scan(root);
  logger.info({ root, count }, 'skills loaded');
  return count;
}

/** Cheap structural match: does this turn look like it wants this skill? */
function matches(text, skill) {
  const hay = text.toLowerCase();
  const desc = skill.description.toLowerCase();
  // word overlap between the turn and the description, weighted by length
  const words = desc.split(/\W+/).filter((w) => w.length > 3);
  const hits = words.filter((w) => hay.includes(w)).length;
  if (hits >= 2) return true;
  // explicit "when" patterns
  if (skill.when) {
    const pats = skill.when.toLowerCase().split(/[|,]/).map((s) => s.trim()).filter(Boolean);
    if (pats.some((p) => hay.includes(p))) return true;
  }
  return false;
}

/**
 * Select skills for a turn. Capped: injecting ten skills costs more than the
 * knowledge is worth.
 */
export function selectSkills(turnText, max = 3) {
  if (!turnText || index.size === 0) return [];
  const picked = [];
  for (const skill of index.values()) {
    if (matches(turnText, skill)) picked.push(skill);
    if (picked.length >= max) break;
  }
  return picked;
}

/** Render selected skills as a system-prompt block. */
export function skillBlock(skills) {
  if (!skills.length) return null;
  const parts = skills.map(
    (s) => `## Skill: ${s.name}\n${s.description}\n\n${s.body.trim().slice(0, 3000)}`,
  );
  return `Relevant skills for this task:\n\n${parts.join('\n\n---\n\n')}`;
}

export function listSkills() {
  return [...index.values()].map((s) => ({ name: s.name, description: s.description, version: s.version }));
}

export function skillCount() {
  return index.size;
}
