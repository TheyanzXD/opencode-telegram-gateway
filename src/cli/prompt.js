// Tiny stdin/stdout prompt helper (no extra deps).
import fs from 'node:fs';
import readline from 'node:readline/promises';

export async function ask(question, { defaultValue, mask = false, validate } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    let prompt = question + (defaultValue ? ` [${mask ? '***' : defaultValue}]` : '') + ': ';
    if (mask) {
      const stdin = process.stdin;
      const stdout = process.stdout;
      stdout.write(prompt);
      const muted = () => stdout.write('');
      stdin.on('data', muted);
      stdin.setRawMode?.(true);
      return new Promise((resolve) => {
        let buf = '';
        const onData = (chunk) => {
          const c = chunk.toString('utf8');
          if (c === '\n' || c === '\r' || c === '\x04') {
            stdin.removeListener('data', onData);
            stdin.setRawMode?.(false);
            stdin.pause();
            stdout.write('\n');
            const v = buf || defaultValue || '';
            if (validate && !validate(v)) return resolve(ask(question, { defaultValue, mask, validate }));
            resolve(v);
            return;
          }
          if (c === '\x7f' || c === '\b') { buf = buf.slice(0, -1); return; }
          if (c === '\x03') { process.exit(1); }
          buf += c;
        };
        stdin.resume();
        stdin.on('data', onData);
      });
    } else {
      const v = (await rl.question(prompt)).trim();
      const value = v || defaultValue || '';
      if (validate && !validate(value)) return ask(question, { defaultValue, mask, validate });
      return value;
    }
  } finally {
    rl.close();
  }
}

export async function choose(question, options, defaultIdx = 0) {
  console.log(question);
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o}`));
  const v = await ask('Choice', { defaultValue: String(defaultIdx + 1) });
  const idx = parseInt(v, 10) - 1;
  if (idx >= 0 && idx < options.length) return options[idx];
  console.log('Invalid choice, defaulting to:', options[defaultIdx]);
  return options[defaultIdx];
}

export function writeIfMissing(path, content) {
  if (fs.existsSync(path)) return false;
  fs.writeFileSync(path, content);
  return true;
}
