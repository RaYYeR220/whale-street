import { describe, expect, it } from 'vitest';
import {
  createReplayFeed,
  type HlFeed,
  type HlRecord,
  type HlTrade,
  recordFeed,
} from '../src/index';

function stubFeed() {
  let midsCb: ((m: Record<string, number>, at: number) => void) | null = null;
  let tradesCb: ((t: HlTrade[]) => void) | null = null;
  const feed: HlFeed = {
    onMids: (cb) => {
      midsCb = cb;
      return () => {
        midsCb = null;
      };
    },
    onTrades: (cb) => {
      tradesCb = cb;
      return () => {
        tradesCb = null;
      };
    },
    onStatus: () => () => {},
    setTradeCoins: () => {},
    start: () => {},
    stop: () => {},
  };
  return {
    feed,
    mids: (m: Record<string, number>, at: number) => midsCb?.(m, at),
    trades: (t: HlTrade[]) => tradesCb?.(t),
  };
}
const trade = (coin: string): HlTrade => ({
  coin,
  side: 'B',
  px: 1,
  sz: 1,
  time: 1,
  hash: 'h',
  users: ['0x1', '0x2'],
});

describe('recordFeed', () => {
  it('filters to tracked coins and throttles mids', () => {
    const s = stubFeed();
    const out: HlRecord[] = [];
    let t = 0;
    const stop = recordFeed(s.feed, (r) => out.push(r), {
      coins: () => new Set(['BTC']),
      now: () => t,
      midsEveryMs: 1_000,
    });
    s.mids({ BTC: 1, ETH: 2 }, 0);
    t = 500;
    s.mids({ BTC: 1.1 }, 500);
    t = 1_000;
    s.mids({ BTC: 1.2 }, 1_000);
    s.trades([trade('ETH')]);
    s.trades([trade('BTC'), trade('ETH')]);
    stop();
    s.mids({ BTC: 9 }, 2_000);
    expect(out).toEqual([
      { t: 0, k: 'hl', channel: 'mids', data: { BTC: 1 } },
      { t: 1_000, k: 'hl', channel: 'mids', data: { BTC: 1.2 } },
      { t: 1_000, k: 'hl', channel: 'trades', data: [trade('BTC')] },
    ]);
  });
});

describe('createReplayFeed', () => {
  it('emits records up to now in order and supports rewind', () => {
    const recs: HlRecord[] = [
      { t: 20, k: 'hl', channel: 'trades', data: [trade('BTC')] },
      { t: 10, k: 'hl', channel: 'mids', data: { BTC: 1 } },
      { t: 30, k: 'hl', channel: 'mids', data: { BTC: 3 } },
    ];
    let now = 25;
    const feed = createReplayFeed(recs, () => now);
    const seen: string[] = [];
    feed.onMids((m, at) => seen.push(`mids:${m.BTC}@${at}`));
    feed.onTrades((t) => seen.push(`trades:${t.length}`));
    feed.advance();
    expect(seen).toEqual(['mids:1@10', 'trades:1']);
    now = 40;
    feed.advance();
    expect(seen).toEqual(['mids:1@10', 'trades:1', 'mids:3@30']);
    feed.advance();
    expect(seen).toHaveLength(3);
    feed.rewind();
    now = 15;
    feed.advance();
    expect(seen[3]).toBe('mids:1@10');
  });
});
