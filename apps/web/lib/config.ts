/**
 * Where the engine lives. NEXT_PUBLIC_ENGINE_URL is inlined at build time; the browser talks to the
 * engine directly (REST + WebSocket). No secret ever reaches this app: the Nansen key stays on the engine.
 */
export const DEFAULT_ENGINE_URL = 'http://localhost:8787';

export function engineUrl(): string {
  const raw = process.env.NEXT_PUBLIC_ENGINE_URL ?? DEFAULT_ENGINE_URL;
  return raw.replace(/\/+$/, '');
}

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
