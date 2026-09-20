---
name: camoufox-antidetect
description: Camoufox notes and known blocks. Load for browser tasks.
when: camoufox|browser|anti-detect|bot detection|captcha|cloudflare
version: 1.0
---

Camoufox is a patched Firefox build (the gateway uses `camoufox-js`) that
reports a clean fingerprint: `navigator.webdriver === false`, a real OS-level
UA, and no Playwright injection markers.

**What works**
- DuckDuckGo HTML (`html.duckduckgo.com/html/?q=`) — stable, no challenge.
- Cloudflare-protected sites that blocked plain Chromium (e.g. nowsecure.nl).
- Normal navigation on most sites.

**What does not, and why**
- Google search → `/sorry`. This is an **IP-level** block on datacenter ranges,
  not a fingerprint loss. No UA or fingerprint change clears it from this host.
  Do not waste turns trying.
- Brave search → captcha wall, same cause.

So the search chain is DDG first. A SOCKS5 proxy would change the egress IP
and may clear both; `browser_search` accepts a proxy slot when one is live.

**Session rules**
- One browser + context + page per chat, created lazily by `getPage(chatId)`.
- `browser_close` ends the session for that chat only.
- `CAMOUFOX_INSTALL_DIR` is resolved by `src/bootstrap.js` from the camou CLI
  registry before camoufox-js is imported — the module evaluates it at
  import time, so setting it later is too late. This is why bootstrap.js is
  the first import in both entry points.

**Refs**
- `browser_snapshot` emits `@eN` refs for interactive elements. Keep them
  across a navigate; `browser_click` rejects a stale ref explicitly rather
  than clicking whatever is at that index now.
- The advanced tools carry their own prefixes: `@fN` form fields, `@sN`
  scroll landmarks, `@oN` select options, `@wN` tabs.

A page that renders client-side is empty on arrival. Use `browser_wait` on
text or a selector — a fixed sleep is a guess.
