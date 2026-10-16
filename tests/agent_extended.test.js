import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import fs from 'node:fs/promises';
import { findTool } from '../src/agent/tools.js';
import { browseWebsite } from '../src/agent/web_browse.js';
import { xerjStatus, xerjSearch, xerjDef } from '../src/agent/xerj.js';

// 1. read_file with start_line and end_line
test('read_file supports start_line and end_line slicing with line numbers', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-slice-'));
  const file = path.join(tmp, 'sample.txt');
  const lines = Array.from({ length: 50 }, (_, i) => `content line ${i + 1}`);
  await fs.writeFile(file, lines.join('\n'));

  const tool = findTool('read_file');
  assert.ok(tool);

  const res = await tool.run({ path: file, start_line: 10, end_line: 14 }, { user: { cwd: tmp } });
  assert.equal(res.ok, true);
  assert.match(res.output, /10 \| content line 10/);
  assert.match(res.output, /14 \| content line 14/);
  assert.match(res.output, /lines 10-14 of 50 total/);
});

// 2. list_dir returns files and directories
test('list_dir enumerates directory contents with types', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-listdir-'));
  await fs.mkdir(path.join(tmp, 'subfolder'));
  await fs.writeFile(path.join(tmp, 'hello.txt'), 'hello world');

  const tool = findTool('list_dir');
  assert.ok(tool);

  const res = await tool.run({ path: '.' }, { user: { cwd: tmp } });
  assert.equal(res.ok, true);
  assert.match(res.output, /\[DIR\]\s+subfolder\//);
  assert.match(res.output, /\[FILE\]\s+hello\.txt/);
});

// 3. find_files locates files by pattern
test('find_files finds files matching wildcard', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-find-'));
  await fs.writeFile(path.join(tmp, 'test1.js'), 'console.log(1)');
  await fs.writeFile(path.join(tmp, 'test2.ts'), 'console.log(2)');

  const tool = findTool('find_files');
  assert.ok(tool);

  const res = await tool.run({ pattern: '*.js' }, { user: { cwd: tmp } });
  assert.equal(res.ok, true);
  assert.match(res.output, /test1\.js/);
  assert.doesNotMatch(res.output, /test2\.ts/);
});

// 4. browseWebsite converts HTML to structured Markdown and extracts links
test('browseWebsite strips noise, converts tables and code, and extracts links', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Test Page Title</title>
          <meta name="description" content="Test Page Description">
          <style>.ad { color: red; }</style>
        </head>
        <body>
          <nav><a href="/home">Home Nav</a></nav>
          <script>console.log("ignore me");</script>
          <article>
            <h1>Main Heading</h1>
            <p>This is paragraph text with a <a href="https://example.org/docs">documentation link</a>.</p>
            <table>
              <tr><th>Name</th><th>Role</th></tr>
              <tr><td>Agent</td><td>Assistant</td></tr>
            </table>
            <pre><code class="language-js">const a = 123;</code></pre>
          </article>
          <footer>Footer Copyright</footer>
        </body>
      </html>
    `);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const testUrl = `http://127.0.0.1:${port}/`;

  try {
    const res = await browseWebsite({ url: testUrl, extract_links: true });
    assert.equal(res.ok, true);
    assert.equal(res.title, 'Test Page Title');
    // Check noise stripping
    assert.doesNotMatch(res.output, /console\.log\("ignore me"\)/);
    assert.doesNotMatch(res.output, /Footer Copyright/);
    // Check Markdown conversion
    assert.match(res.output, /# Main Heading/);
    assert.match(res.output, /\| Name \| Role \|/);
    assert.match(res.output, /\| Agent \| Assistant \|/);
    assert.match(res.output, /```js\nconst a = 123;\n```/);
    // Check link extraction
    assert.ok(res.links && res.links.length > 0);
    assert.ok(res.links.some((l) => l.url === 'https://example.org/docs'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// 5. XERJ search and def integration
test('XERJ integration: status, passage search and definition lookup', async () => {
  const st = await xerjStatus();
  // Server is running in test environment
  if (st.running) {
    assert.equal(st.ok, true);
    assert.equal(st.cluster_name, 'xerj');

    const searchRes = await xerjSearch('runAgent');
    assert.equal(searchRes.ok, true);
    assert.match(searchRes.output, /runAgent/);

    const defRes = await xerjDef('runAgent');
    assert.equal(defRes.ok, true);
    assert.match(defRes.output, /runAgent/);
  }
});
