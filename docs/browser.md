# Browser Tools (`/browse`)

The bot can drive a real headless Chromium — open pages, read them, click,
type, screenshot. This is the same stack Hermes Agent uses: the
[`agent-browser`](https://www.npmjs.com/package/agent-browser) npm package
plus Playwright Chromium, driven over a subprocess.

## Install

`agent-browser` is already a dependency of this repo — `npm ci` installs it.
The one thing it does **not** bundle is Chromium (~150 MB), because shipping
that in every install would be wasteful.

The first `/browse` in a fresh clone fetches Chromium once, then proceeds.
To do it ahead of time instead:

```bash
npm run browser install    # fetch Chromium now, one-time
npm run browser status     # is it resolvable?
npm run browser verify https://example.com   # open + read a page
```

Resolution order for the binary: `AGENT_BROWSER_BIN` → the local dependency
→ any `agent-browser` on PATH. If none is found, `/browse` replies with the
install line instead of crashing.

## Commands

```
/browse open <url>        Open URL in headless Chromium
/browse read              Extract page text (markdown-ish)
/browse snapshot          List interactive elements as @eN refs
/browse click <ref|sel>   Click an element or @eN ref
/browse type <sel> <text> Type into an element
/browse fill <sel> <text> Clear and fill
/browse press <key>       Enter / Tab / Control+a
/browse scroll <dir>      up|down|left|right [px]
/browse wait <ms|sel>     Sleep, or wait for a selector
/browse back / forward / reload
/browse screenshot        Capture the page
/browse url / title       Current URL / page title
/browse eval <js>         Run JavaScript on the page
/browse close             Close the session
```

## The workflow

`open` → `snapshot` → `click` → `read`. Snapshot is the important one: it
walks the accessibility tree and prints every interactive element with a
stable ref. Click against those refs, not against selectors you guessed.

```
/browse open https://news.ycombinator.com
/browse snapshot
→ ✅ Interactive elements (use @eN with click/type/fill):
   link @e101
   link "Hacker News" @e102
   link "new" @e103
   ...

/browse click @e103        ← follows the "new" link
/browse read               ← text of the new page
```

State persists between commands — one browser session per Telegram chat.
Everything you do stays on the same page until `/browse close` (or the
process restarts, which drops all sessions).

## When it breaks

| Symptom | Meaning |
|---|---|
| `Chromium not found` | `agent-browser install chromium` was never run |
| `Element not found` | Page changed since your last `snapshot` — re-run it |
| `Timed out` | Slow page; `/browse wait 2000` then retry |
| `Target page has been closed` | Session died — `/browse open <url>` again |
| `/browse` answers with the install line | `agent-browser` binary not on PATH, or set `AGENT_BROWSER_BIN` |

## Security notes

- Every `/browse` user gets a real browser with outbound network. There is
  no sandbox or URL allowlist — if you expose the bot to untrusted users,
  gate `/browse` behind admin before deploying.
- `eval` runs arbitrary JavaScript in the page. It is not a privilege
  escalation (it is sandboxed to the browser), but it can hit any URL the
  browser can reach.
- Sessions hold cookies and localStorage until `/browse close`. If you log
  into something, anyone using that chat is logged in afterwards.

## Configuration

```bash
# .env — optional
AGENT_BROWSER_BIN=/usr/local/bin/agent-browser   # default: agent-browser on PATH
```

That is the only knob. Everything else (viewport, headers, offline
simulation) is a runtime command: `agent-browser set viewport 1280 720`
is `/browse set viewport 1280 720`.
