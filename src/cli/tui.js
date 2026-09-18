// Tiny TUI: switch provider/model, edit system prompt, clear history.
import { ask } from './prompt.js';
import { allModels, providerNames } from '../providers/store.js';
import { getUser, setUserModel, setUserSystemPrompt, clearHistory } from '../db.js';

export async function tui() {
  console.log('OpenCode Gateway — TUI\n');
  const tgId = parseInt(await ask('Telegram user ID to manage'), 10);
  if (!Number.isFinite(tgId)) return;
  let u = getUser(tgId);
  if (!u) { console.log('No such user yet.'); return; }

  for (;;) {
    console.log(`\nUser ${tgId}: provider=${u.provider}  model=${u.model}  temp=${u.temperature}`);
    console.log('  system:', (u.system_prompt || '(default)').slice(0, 80));
    console.log('\n  1) change model');
    console.log('  2) change system prompt');
    console.log('  3) clear history');
    console.log('  4) quit');
    const choice = await ask('Choice', { defaultValue: '1' });
    if (choice === '1') {
      console.log('Providers:', providerNames().join(', '));
      const provider = await ask('Provider', { defaultValue: u.provider });
      const models = allModels().filter((m) => m.provider === provider);
      console.log(models.map((m) => m.id).join('\n'));
      const model = await ask('Model', { defaultValue: u.model });
      setUserModel(tgId, provider, model);
      u = { ...u, provider, model };
    } else if (choice === '2') {
      const sp = await ask('System prompt');
      setUserSystemPrompt(tgId, sp);
      u = { ...u, system_prompt: sp };
    } else if (choice === '3') {
      const n = clearHistory(tgId);
      console.log('cleared', n);
    } else if (choice === '4') {
      break;
    }
  }
}
