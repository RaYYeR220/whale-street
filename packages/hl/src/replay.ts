import type { Marks } from '@whale-street/core';
import type { FeedStatus, HlFeed, HlTrade } from './feed';

export type HlRecord =
  | { t: number; k: 'hl'; channel: 'mids'; data: Record<string, number> }
  | { t: number; k: 'hl'; channel: 'trades'; data: HlTrade[] };

export function recordFeed(
  feed: HlFeed,
  sink: (r: HlRecord) => void,
  o: { coins: () => ReadonlySet<string>; now: () => number; midsEveryMs?: number },
): () => void {
  const every = o.midsEveryMs ?? 1_000;
  let lastMids = Number.NEGATIVE_INFINITY;
  const offMids = feed.onMids((m) => {
    const t = o.now();
    if (t - lastMids < every) return;
    const tracked = o.coins();
    const data: Record<string, number> = {};
    for (const [coin, px] of Object.entries(m)) if (tracked.has(coin)) data[coin] = px;
    lastMids = t;
    sink({ t, k: 'hl', channel: 'mids', data });
  });
  const offTrades = feed.onTrades((trades) => {
    const tracked = o.coins();
    const data = trades.filter((x) => tracked.has(x.coin));
    if (data.length > 0) sink({ t: o.now(), k: 'hl', channel: 'trades', data });
  });
  return () => {
    offMids();
    offTrades();
  };
}

export interface ReplayFeed extends HlFeed {
  advance(): void;
  rewind(): void;
}

export function createReplayFeed(records: readonly HlRecord[], now: () => number): ReplayFeed {
  const sorted = [...records].sort((a, b) => a.t - b.t);
  const mids = new Set<(m: Marks, at: number) => void>();
  const trades = new Set<(t: HlTrade[]) => void>();
  const status = new Set<(s: FeedStatus) => void>();
  let cursor = 0;

  const add = <T>(set: Set<T>, cb: T) => {
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  };

  return {
    onMids: (cb) => add(mids, cb),
    onTrades: (cb) => add(trades, cb),
    onStatus: (cb) => add(status, cb),
    setTradeCoins: () => {},
    start: () => {
      for (const cb of status) cb('open');
    },
    stop: () => {
      for (const cb of status) cb('closed');
    },
    advance() {
      const t = now();
      while (cursor < sorted.length && (sorted[cursor] as HlRecord).t <= t) {
        const r = sorted[cursor] as HlRecord;
        cursor++;
        if (r.channel === 'mids') for (const cb of mids) cb(r.data, r.t);
        else for (const cb of trades) cb(r.data);
      }
    },
    rewind() {
      cursor = 0;
    },
  };
}
