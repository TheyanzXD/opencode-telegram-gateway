import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { z as zod } from 'zod';

// 1. zodJsonSchema produces OpenAI-shape tool defs
test('toolToDef produces OpenAI function schema', async () => {
  const { toolToDef, schemaToJsonSchema } = await import('../src/agent/zodJsonSchema.js');
  const schema = zod.object({
    path: zod.string().describe('file path'),
    count: zod.number().int().min(1).max(10).optional(),
  });
  const def = toolToDef({ name: 'noop', description: 'test', schema });
  assert.equal(def.type, 'function');
  assert.equal(def.function.name, 'noop');
  assert.equal(def.function.parameters.type, 'object');
  assert.deepEqual(def.function.parameters.required, ['path']);
  assert.equal(def.function.parameters.properties.path.type, 'string');
  assert.equal(def.function.parameters.properties.count.type, 'number');
});

// 2. sandbox rejects escape attempts
test('safeResolve blocks path traversal', async () => {
  const { safeResolve, SandboxError } = await import('../src/agent/sandbox.js');
  const cwd = '/tmp/inside';
  assert.equal(safeResolve(cwd, 'a.txt'), path.resolve(cwd, 'a.txt'));
  assert.throws(() => safeResolve(cwd, '../escape.txt'), SandboxError);
  assert.throws(() => safeResolve(cwd, '/etc/passwd'), SandboxError);
});

// 3. bash_exec respects approval denial
test('bash_exec returns denial without executing', async () => {
  const { findTool } = await import('../src/agent/tools.js');
  const tool = findTool('bash_exec');
  assert.ok(tool);
  let asked = false;
  const result = await tool.run(
    { command: 'echo should-not-run' },
    { user: { cwd: '/tmp' }, askApproval: async () => { asked = true; return { allow: false, reason: 'test denied' }; } }
  );
  assert.equal(asked, true);
  assert.equal(result.ok, false);
  assert.match(result.error, /denied/);
});

// 4. read_file truncation
test('read_file caps lines', async () => {
  const fs = await import('node:fs/promises');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-test-'));
  const file = path.join(tmp, 'big.txt');
  const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n');
  await fs.writeFile(file, lines);
  const { findTool } = await import('../src/agent/tools.js?x=' + Date.now());
  const tool = findTool('read_file');
  const result = await tool.run({ path: file, max_lines: 5 }, { user: { cwd: tmp } });
  assert.equal(result.ok, true);
  assert.match(result.output, /showing 5\/1000 lines/);
});