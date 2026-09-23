import type { Marks } from '@whale-street/core';

export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WsFactory = (url: string) => WsLike;

export interface HlTrade {
  coin: string;
  side: 'B' | 'A';
  px: number;
  sz: number;
  time: number;
  hash: string;
  users: readonly [string, string];
}

export type FeedStatus = 'connecting' | 'open' | 'closed';

export interface HlFeed {
  onMids(cb: (m: Marks, at: number) => void): () => void;
  onTrades(cb: (t: HlTrade[]) => void): () => void;
  onStatus(cb: (s: FeedStatus) => void): () => void;
  setTradeCoins(coins: readonly string[]): void;
  start(): void;
  stop(): void;
}

export function parseMids(data: unknown): Marks {
  const mids = (data as { mids?: unknown } | null)?.mids;
  if (!mids || typeof mids !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [coin, v] of Object.entries(mids as Record<string, unknown>)) {
    if (coin.startsWith('@')) continue;
    if (typeof v !== 'number' && typeof v !== 'string') continue;
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n) && n > 0) out[coin] = n;
  }
  return out;
}

export function parseTrades(data: unknown): HlTrade[] {
  if (!Array.isArray(data)) return [];
  const out: HlTrade[] = [];
  for (const row of data) {
    if (typeof row !== 'object' || row === null) continue;
    const t = row as Record<string, unknown>;
    const users = t.users;
    if (!Array.isArray(users) || users.length !== 2) continue;
    const px = Number(t.px);
    const sz = Number(t.sz);
    if (typeof t.coin !== 'string' || !Number.isFinite(px) || !Number.isFinite(sz)) continue;
    out.push({
      coin: t.coin,
      side: t.side === 'B' ? 'B' : 'A',
      px,
      sz,
      time: Number(t.time),
      hash: String(t.hash ?? ''),
      users: [String(users[0]).toLowerCase(), String(users[1]).toLowerCase()],
    });
  }
  return out;
}

class Listeners<A extends unknown[]> {
  private readonly set = new Set<(...a: A) => void>();
  add(cb: (...a: A) => void): () => void {
    this.set.add(cb);
    return () => this.set.delete(cb);
  }
  emit(...a: A) {
    for (const cb of this.set) cb(...a);
  }
}

export function createHlFeed(
  o: {
    url?: string;
    wsFactory?: WsFactory;
    pingMs?: number;
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
    now?: () => number;
  } = {},
): HlFeed {
  const url = o.url ?? 'wss://api.hyperliquid.xyz/ws';
  const factory: WsFactory = o.wsFactory ?? ((u) => new WebSocket(u) as unknown as WsLike);
  const pingMs = o.pingMs ?? 30_000;
  const base = o.reconnectBaseMs ?? 1_000;
  const max = o.reconnectMaxMs ?? 30_000;
  const now = o.now ?? Date.now;

  const mids = new Listeners<[Marks, number]>();
  const trades = new Listeners<[HlTrade[]]>();
  const status = new Listeners<[FeedStatus]>();
  let coins = new Set<string>();
  let ws: WsLike | null = null;
  let isOpen = false;
  let running = false;
  let attempt = 0;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const send = (msg: unknown) => {
    if (ws && isOpen) ws.send(JSON.stringify(msg));
  };
  const sub = (coin: string) =>
    send({ method: 'subscribe', subscription: { type: 'trades', coin } });
  const unsub = (coin: string) =>
    send({ method: 'unsubscribe', subscription: { type: 'trades', coin } });

  const clearTimers = () => {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const connect = () => {
    status.emit('connecting');
    const sock = factory(url);
    ws = sock;
    // Liveness watchdog: tracks the last time *any* message (including a pong) arrived on this
    // socket. A connection that stops responding entirely (dead peer, silently dropped NAT
    // mapping, etc.) never fires `onclose` on its own, so we force the issue.
    let lastMsgAt = now();
    // The backoff exponent is reset only once real traffic has been seen on a socket, not merely
    // on open: a server that accepts a connection and then immediately closes it (or never speaks)
    // must not repeatedly reset us back to the fastest retry pace.
    let gotFirstMessage = false;
    sock.onopen = () => {
      if (ws !== sock) return;
      isOpen = true;
      status.emit('open');
      send({ method: 'subscribe', subscription: { type: 'allMids' } });
      for (const c of coins) sub(c);
      pingTimer = setInterval(() => {
        if (now() - lastMsgAt > 2 * pingMs) {
          sock.close();
          return;
        }
        send({ method: 'ping' });
      }, pingMs);
    };
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      lastMsgAt = now();
      if (!gotFirstMessage) {
        gotFirstMessage = true;
        attempt = 0;
      }
      let msg: { channel?: unknown; data?: unknown };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.channel === 'allMids') {
        const m = parseMids(msg.data);
        // An empty parse (no usable coin entries) is never emitted: it's indistinguishable from a
        // malformed payload, and downstream code must not mistake it for a real, empty snapshot.
        if (Object.keys(m).length > 0) mids.emit(m, now());
      } else if (msg.channel === 'trades') {
        const t = parseTrades(msg.data);
        if (t.length > 0) trades.emit(t);
      }
    };
    sock.onerror = () => {};
    sock.onclose = () => {
      if (ws !== sock) return;
      isOpen = false;
      ws = null;
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = null;
      status.emit('closed');
      if (!running) return;
      const delay = Math.min(max, base * 2 ** attempt);
      attempt++;
      reconnectTimer = setTimeout(connect, delay);
    };
  };

  return {
    onMids: (cb) => mids.add(cb),
    onTrades: (cb) => trades.add(cb),
    onStatus: (cb) => status.add(cb),
    setTradeCoins(next) {
      const nextSet = new Set(next);
      for (const c of nextSet) if (!coins.has(c)) sub(c);
      for (const c of coins) if (!nextSet.has(c)) unsub(c);
      coins = nextSet;
    },
    start() {
      if (running) return;
      running = true;
      connect();
    },
    stop() {
      running = false;
      attempt = 0;
      clearTimers();
      const sock = ws;
      ws = null;
      isOpen = false;
      sock?.close();
    },
  };
}
