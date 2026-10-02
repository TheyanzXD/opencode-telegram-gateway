# Browser tools (agent)

The browser is not a chat command. It is a set of tools the agent calls itself,
the same way Hermes Agent does — the model decides when to open a page, what to
click, and what to read, inside a `/agent` turn.

```
/agent "find the cheapest VPS on hetzner and tell me the price"
  → browser_search    (engine fallback chain)
  → browser_navigate  (open a result)
  → browser_snapshot  (element map)
  → browser_click     (approved — it mutates state on a remote site)
  → browser_read      (the price)
```

## The tools

| Tool | Danger | What it does |
|---|---|---|
| `browser_navigate` | read | Open a URL in Camoufox. Returns title + first 600 chars. |
| `browser_snapshot` | read | List every clickable element as stable `@eN` refs. |
| `browser_read` | read | Full text of the page, or of one element. Capped at 12 KB. |
| `browser_click` | **yes** | Click an `@eN` ref or a selector. Pauses for approval. |
| `browser_type` | **yes** | Fill a form field, optionally Enter. Pauses for approval. |
| `browser_search` | read | Web search with engine fallback. |
| `browser_close` | read | Close the session, free the browser. |

Read-only tools run without asking. `browser_click` and `browser_type` mutate
state on a real remote site — submit a form, place an order, delete a thing — so
they are flagged dangerous and the engine parks them behind a one-tap approval
(`/yolo on` skips it; see [agent.md](agent.md)).

## The workflow that makes it work

```
browser_navigate → browser_snapshot → browser_click → browser_read
```

The snapshot is the load-bearing step. It walks the accessibility tree and
hands the model stable `@eN` refs. Clicks aim at real elements instead of a
selector the model guessed from page text — and when the page changed since the
last snapshot, the ref is stale and the tool says so instead of clicking
whatever now sits at that index.

Splitting snapshot and read matters for context: a big page does not fit in one
window. Snapshot is the compressed map; `browser_read` pulls the text when the
model decides it needs it.

## One session per chat

Camoufox lives in a per-chat map: `browser_navigate` from chat A never touches
chat B's page. The turn lease guarantees one agent turn per chat, and two chats
running concurrently get two browsers, not one shared page.

A session survives until `browser_close`, until the process restarts, or until
a stale lease is reclaimed (5 min). Cookies and localStorage persist for the
life of the session — see the security notes below.

## Why Camoufox, not plain Chromium

On a datacenter IP, headless Chromium is hard-blocked: Google redirects to
`/sorry` before the page loads, and Brave serves its "verifying you're not a
bot" interstitial. Neither is a fingerprint check the browser can pass — they
are IP reputation decisions made before the page renders. Stealth init scripts
and realistic UAs do not change the IP.

Camoufox spoofs a real Windows/Firefox fingerprint (`navigator.webdriver`
false, matching UA/plugins/WebGL), which clears the browser-side checks. The
search chain then handles the IP: it tries engines in order and stops at the
first that returns results.

## Search engines

`browser_search` walks this chain and stops at the first engine that returns
results:

| Engine | URL | Notes |
|---|---|---|
| DuckDuckGo HTML | `html.duckduckgo.com/html/` | no-JS endpoint, works on this IP |
| DuckDuckGo Lite | `lite.duckduckgo.com/lite/` | smaller page, same index |
| Brave | `search.brave.com/search` | captcha-walled on this IP; needs a residential proxy |

Google is deliberately absent — it redirects this IP to `/sorry` regardless of
fingerprint. The model can still `browser_navigate` to a Google URL directly;
the chain exists to return results, not to serve a specific engine.

A navigation that "succeeded" can still land on a bot wall. The chain reads the
page before trusting it, and these markers advance to the next engine:

- Google `/sorry` and "unusual traffic from your computer network"
- Brave's "Verifying you're not a bot"
- "Checking your browser before accessing"

## Install

```bash
npx camou install        # Camoufox (~150 MB) — one time
```

That is the whole setup. `src/bootstrap.js` reads the `camou` CLI's own
registry at startup, sets `CAMOUFOX_INSTALL_DIR` to the installed version, and
rewrites `version.json` into the shape `camoufox-js` expects — so a fresh clone
needs no manual env and no patched library. If Camoufox is missing, the browser
tools answer with the install line instead of crashing.

There is no Chromium involved anymore. The old `agent-browser` / `/browse`
command stack was removed when the browser moved into the agent.

## When it breaks

| Symptom | Meaning |
|---|---|
| `Camoufox is not installed` | `npx camou install` was never run on this host |
| `stale ref @eN` | The page changed since the last snapshot — call it again |
| `click failed: Timeout … waiting for locator` | Element is not clickable yet, or is in an overlay — `browser_snapshot` again |
| `navigation failed: net::ERR_NAME_NOT_RESOLVED` | DNS — the URL, or the host's resolver |
| search returns "no search engine returned results" | Every engine is blocked from this IP — use a proxy, or navigate directly |
| `browser_… failed` with a Playwright trace | The page closed or crashed mid-call — `browser_navigate` again |

## Security notes

- Every user with `/agent` gets a real browser with outbound network. There is
  no sandbox and no URL allowlist. Gate `AGENT_ENABLED` before exposing the bot
  to untrusted users.
- `browser_click` and `browser_type` are approval-gated precisely because they
  reach the real web. A logged-in session plus a click is a real action.
- Sessions hold cookies and localStorage until `browser_close`. If the model
  logs into something, that login persists for the rest of the session.
- The browser runs as the bot's own process and user. It can reach anything the
  host can reach — internal services included, if they are not firewalled.
