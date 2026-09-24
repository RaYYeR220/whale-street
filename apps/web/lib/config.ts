/**
 * Where the engine lives. NEXT_PUBLIC_ENGINE_URL is inlined at build time; the browser talks to the
 * engine directly (REST + WebSocket). No secret ever reaches this app: the Nansen key stays on the engine.
 */
export const DEFAULT_ENGINE_URL = 'http://localhost:8787';

export const MISSING_ENGINE_URL =
  'NEXT_PUBLIC_ENGINE_URL is not set. A production build compiles the engine address into the site, so set it in the build environment (on Vercel: Project Settings, Environment Variables), for example NEXT_PUBLIC_ENGINE_URL=https://engine.example.com';

/**
 * The engine address for one environment. A production build must name its engine: without it
 * the site would ship talking to localhost and show "Cannot reach the engine" everywhere. Dev and
 * tests fall back to the local engine.
 */
export function resolveEngineUrl(nodeEnv: string | undefined, configured: string | undefined) {
  const raw = configured?.trim();
  if (!raw) {
    if (nodeEnv === 'production') throw new Error(MISSING_ENGINE_URL);
    return DEFAULT_ENGINE_URL;
  }
  return raw.replace(/\/+$/, '');
}

export function engineUrl(): string {
  return resolveEngineUrl(process.env.NODE_ENV, process.env.NEXT_PUBLIC_ENGINE_URL);
}

// Runs when this module loads, which every page does while `next build` collects them: a
// production build without the engine address fails here with the message above.
engineUrl();

/** http(s)://host → ws(s)://host/ws */
export function wsUrlFor(base: string): string {
  const u = new URL(base);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/ws`;
  u.search = '';
  u.hash = '';
  return u.toString();
}

export function mcpUrlFor(base: string): string {
  return `${base.replace(/\/+$/, '')}/mcp`;
}

/** Optional public source link for the footer; the link is hidden when unset. */
export function repoUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_REPO_URL;
  return raw && /^https:\/\//.test(raw) ? raw : null;
}

/** Hyperliquid explorer page for an address. */
export const explorerAddressUrl = (address: string): string =>
  `https://app.hyperliquid.xyz/explorer/address/${address}`;
