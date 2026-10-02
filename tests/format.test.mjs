import { toTelegramMarkdown, splitLong } from '../src/format.js';

let fails = 0;
const t = (name, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log((ok ? 'PASS' : 'FAIL'), name);
  if (!ok) console.log('  got :', JSON.stringify(got), '\n  want:', JSON.stringify(want));
};

t('snake_case', toTelegramMarkdown('the user_model_name field'), 'the user\\_model\\_name field');
t('real italic', toTelegramMarkdown('this is _important_'), 'this is _important_');
t('real bold', toTelegramMarkdown('this is *important*'), 'this is *important*');
t('lone star', toTelegramMarkdown('5 * 4 = 20'), '5 \\* 4 = 20');
t('code span', toTelegramMarkdown('use `user_model_name` here'), 'use `user_model_name` here');
t('code block', toTelegramMarkdown('```js\nconst a_b = 5;\n```'), '```js\nconst a_b = 5;\n```');
t('block + snake', toTelegramMarkdown('see ```x_y``` ok'), 'see ```x_y``` ok');

const paras = 'A'.repeat(10) + '\n\n' + 'B'.repeat(10) + '\n\n' + 'C'.repeat(10);
const parts = splitLong(paras, 15);
console.log('splitLong parts:', JSON.stringify(parts));
if (parts.length !== 3) { fails++; console.log('FAIL split count', parts.length); }
if (parts[0] !== 'A'.repeat(10)) { fails++; console.log('FAIL split[0]'); }

const run = 'x'.repeat(50);
const hp = splitLong(run, 10);
if (hp.length !== 5) { fails++; console.log('FAIL hardchop', hp.length); }

console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILURES`);
if (fails) throw new Error(`${fails} format test(s) failed`);
