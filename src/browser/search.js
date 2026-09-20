// language: JavaScript (Node 20+ ESM), file: src/browser/search.js
// Search-engine fallback chain.
//
// The problem: Google blocks datacenter IPs at the network layer — a request
// from this VPS to google.com/search is redirected to /sorry regardless of
// browser fingerprint or UA. No amount of stealth fixes that; it is an IP
// reputation decision made before the page loads.
//
// The fix is to not start at Google. These engines serve real results to
// datacenter IPs. The order is by result quality, not by brand.
//
//    brave    — clean results, no JS wall, works out of the box
//    ddg-html — no-JS endpoint, works everywhere, slightly noisier markup
//    ddg-lite — minimal page, last resort on a bad connection
//
// google is intentionally absent from the chain. A user can still /browse open
// google.com directly; this chain is only for /search, where the goal is
// results, not a specific engine.

export const SEARCH_ENGINES = [
  {
    id: 'brave',
    label: 'Brave',
    /** URL for a query. */
    url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}`,
    /** Whether this engine is worth trying given the current conditions. */
    available: () => true,
  },
  {
    id: 'ddg',
    label: 'DuckDuckGo',
    url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    available: () => true,
  },
  {
    id: 'ddg-lite',
    label: 'DuckDuckGo Lite',
    url: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
    available: () => true,
  },
];

/**
 * The ordered list of engines to try, minus any that are known-bad right now.
 * A proxy from the residential pool unlocks engines that block the bare IP.
 */
export function engineChain({ hasResidentialProxy = false } = {}) {
  const google = {
    id: 'google',
    label: 'Google',
    url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
    // Google only serves this IP through /sorry without a residential proxy
    available: () => hasResidentialProxy,
  };
  return [google, ...SEARCH_ENGINES].filter((e) => e.available());
}

export function engineById(id) {
  return engineChain({ hasResidentialProxy: true }).find((e) => e.id === id) || null;
}
