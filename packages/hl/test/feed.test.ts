import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlFeed, type HlTrade, parseMids, parseTrades, type WsLike } from '../src/index';

class FakeWs implements WsLike {
  static all: FakeWs[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeWs.all.push(this);
  }
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  emit(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

beforeEach(() => {
  FakeWs.all = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const latest = () => FakeWs.all[FakeWs.all.length - 1] as FakeWs;

describe('parsers', () => {
  it('parseMids drops spot keys and non-numbers', () => {
    expect(parseMids({ mids: { BTC: '64000.5', '@1': '2', ETH: 'x', HYPE: 40 } })).toEqual({
      BTC: 64_000.5,
      HYPE: 40,
    });
    expect(parseMids(null)).toEqual({});
  });
  it('parseMids rejects boolean values', () => {
    expect(parseMids({ mids: { BTC: true, ETH: '5' } })).toEqual({ ETH: 5 });
  });
  it('parseTrades maps and lowercases users', () => {
    const t = parseTrades([
      {
        coin: 'BTC',
        side: 'B',
        px: '64000',
        sz: '0.1',
        time: 5,
        hash: '0xh',
        tid: 1,
        users: ['0xAA', '0xBb'],
      },
    ]);
    expect(t).toEqual([
      {
        coin: 'BTC',
        side: 'B',
        px: 64_000,
        sz: 0.1,
        time: 5,
        hash: '0xh',
        users: ['0xaa', '0xbb'],
      },
    ]);
    expect(parseTrades('nope')).toEqual([]);
  });
  it('parseTrades skips null and other non-object rows', () => {
    const valid = {
      coin: 'BTC',
      side: 'B',
      px: '1',
      sz: '1',
      time: 1,
      hash: 'h',
      users: ['0x1', '0x2'],
    };
    expect(parseTrades([null, 5, 'x', valid])).toEqual([
      { coin: 'BTC', side: 'B', px: 1, sz: 1, time: 1, hash: 'h', users: ['0x1', '0x2'] },
    ]);
  });

  it('parseTrades skips rows with a side other than B or A', () => {
    const base = { coin: 'BTC', px: '1', sz: '1', time: 1, hash: 'h', users: ['0x1', '0x2'] };
    expect(parseTrades([{ ...base, side: 'X' }])).toEqual([]);
    expect(parseTrades([{ ...base, side: undefined }])).toEqual([]);
    expect(parseTrades([{ ...base, side: 'b' }])).toEqual([]);
  });

  it('parseTrades skips rows with px/sz that are not strict positive decimals', () => {
    const base = { coin: 'BTC', side: 'B', time: 1, hash: 'h', users: ['0x1', '0x2'] };
    for (const px of ['0', '-1', '0x10', '1e3', '', ' ', 'abc', Number.NaN, null]) {
      expect(parseTrades([{ ...base, px, sz: '1' }])).toEqual([]);
    }
    for (const sz of ['0', '-1', '0x10', '1e3', '', ' ', 'abc', Number.NaN, null]) {
      expect(parseTrades([{ ...base, px: '1', sz }])).toEqual([]);
    }
  });

  it('parseTrades skips rows whose time is not a finite positive number', () => {
    const base = { coin: 'BTC', side: 'B', px: '1', sz: '1', hash: 'h', users: ['0x1', '0x2'] };
    for (const time of [0, -1, Number.NaN, null, undefined, '']) {
      expect(parseTrades([{ ...base, time }])).toEqual([]);
    }
  });

  it('parseTrades skips rows whose users are not two non-empty strings', () => {
    const base = { coin: 'BTC', side: 'B', px: '1', sz: '1', time: 1, hash: 'h' };
    expect(parseTrades([{ ...base, users: ['0x1'] }])).toEqual([]);
    expect(parseTrades([{ ...base, users: ['0x1', ''] }])).toEqual([]);
    expect(parseTrades([{ ...base, users: ['0x1', '  '] }])).toEqual([]);
    expect(parseTrades([{ ...base, users: ['0x1', 2] }])).toEqual([]);
    expect(parseTrades([{ ...base, users: null }])).toEqual([]);
  });
});

describe('createHlFeed', () => {
  it('subscribes on open, dispatches mids and trades', () => {
    const feed = createHlFeed({ wsFactory: (u) => new FakeWs(u), now: () => 7 });
    const mids: unknown[] = [];
    const trades: HlTrade[][] = [];
    feed.onMids((m, at) => mids.push([m, at]));
    feed.onTrades((t) => trades.push(t));
    feed.setTradeCoins(['BTC']);
    feed.start();
    latest().open();
    expect(latest().sent).toEqual([
      { method: 'subscribe', subscription: { type: 'allMids' } },
      { method: 'subscribe', subscription: { type: 'trades', coin: 'BTC' } },
    ]);
    latest().emit({ channel: 'allMids', data: { mids: { BTC: '1' } } });
    latest().emit({
      channel: 'trades',
      data: [
        { coin: 'BTC', side: 'A', px: '1', sz: '2', time: 3, hash: 'h', users: ['0x1', '0x2'] },
      ],
    });
    latest().emit({ channel: 'pong' });
    latest().onmessage?.({ data: 'garbage' });
    expect(mids).toEqual([[{ BTC: 1 }, 7]]);
    expect(trades[0]?.[0]?.coin).toBe('BTC');
  });

  it('does not emit onMids for an empty parse', () => {
    const feed = createHlFeed({ wsFactory: (u) => new FakeWs(u) });
    const mids: unknown[] = [];
    feed.onMids((m) => mids.push(m));
    feed.start();
    latest().open();
    latest().emit({ channel: 'allMids', data: { mids: {} } });
    latest().emit({ channel: 'allMids', data: { mids: { '@1': '2' } } });
    expect(mids).toEqual([]);
    latest().emit({ channel: 'allMids', data: { mids: { BTC: '1' } } });
    expect(mids).toEqual([{ BTC: 1 }]);
  });

  it('diffs trade subscriptions while open', () => {
    const feed = createHlFeed({ wsFactory: (u) => new FakeWs(u) });
    feed.setTradeCoins(['BTC', 'ETH']);
    feed.start();
    latest().open();
    latest().sent = [];
    feed.setTradeCoins(['ETH', 'SOL']);
    expect(latest().sent).toEqual([
      { method: 'subscribe', subscription: { type: 'trades', coin: 'SOL' } },
      { method: 'unsubscribe', subscription: { type: 'trades', coin: 'BTC' } },
    ]);
  });

  it('pings while open and reconnects with backoff after close', () => {
    const statuses: string[] = [];
    const feed = createHlFeed({
      wsFactory: (u) => new FakeWs(u),
      pingMs: 1_000,
      reconnectBaseMs: 100,
      reconnectMaxMs: 400,
    });
    feed.onStatus((s) => statuses.push(s));
    feed.start();
    latest().open();
    vi.advanceTimersByTime(1_000);
    expect(latest().sent).toContainEqual({ method: 'ping' });
    latest().close();
    expect(FakeWs.all).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(FakeWs.all).toHaveLength(2);
    latest().close();
    vi.advanceTimersByTime(199);
    expect(FakeWs.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWs.all).toHaveLength(3);
    latest().open();
    expect(latest().sent[0]).toEqual({ method: 'subscribe', subscription: { type: 'allMids' } });
    expect(statuses).toEqual([
      'connecting',
      'open',
      'closed',
      'connecting',
      'closed',
      'connecting',
      'open',
    ]);
  });

  it('stop() closes and prevents reconnects', () => {
    const feed = createHlFeed({ wsFactory: (u) => new FakeWs(u), reconnectBaseMs: 10 });
    feed.start();
    latest().open();
    feed.stop();
    vi.advanceTimersByTime(10_000);
    expect(FakeWs.all).toHaveLength(1);
  });

  it('ignores messages from a superseded socket after reconnect', () => {
    const feed = createHlFeed({ wsFactory: (u) => new FakeWs(u), reconnectBaseMs: 10 });
    const mids: unknown[] = [];
    feed.onMids((m) => mids.push(m));
    feed.start();
    const sock1 = latest();
    sock1.open();
    sock1.close();
    vi.advanceTimersByTime(10);
    const sock2 = latest();
    expect(sock2).not.toBe(sock1);
    sock1.emit({ channel: 'allMids', data: { mids: { ETH: '1' } } });
    expect(mids).toEqual([]);
    sock2.open();
    sock2.emit({ channel: 'allMids', data: { mids: { BTC: '1' } } });
    expect(mids).toEqual([{ BTC: 1 }]);
  });

  it('ignores a late message on a socket after stop()', () => {
    const feed = createHlFeed({ wsFactory: (u) => new FakeWs(u) });
    const mids: unknown[] = [];
    feed.onMids((m) => mids.push(m));
    feed.start();
    const sock = latest();
    sock.open();
    feed.stop();
    sock.emit({ channel: 'allMids', data: { mids: { BTC: '1' } } });
    expect(mids).toEqual([]);
  });

  it('closes and reconnects the socket if no message (including pong) arrives for over 2x pingMs', () => {
    const feed = createHlFeed({
      wsFactory: (u) => new FakeWs(u),
      pingMs: 1_000,
      reconnectBaseMs: 10,
    });
    feed.start();
    latest().open();
    expect(FakeWs.all).toHaveLength(1);
    vi.advanceTimersByTime(1_000); // elapsed 1_000: within budget, sends a ping
    expect(latest().sent).toContainEqual({ method: 'ping' });
    expect(FakeWs.all).toHaveLength(1);
    vi.advanceTimersByTime(1_000); // elapsed 2_000: not yet strictly over 2x pingMs
    expect(FakeWs.all).toHaveLength(1);
    vi.advanceTimersByTime(1_000); // elapsed 3_000: over budget, watchdog closes the socket
    expect(FakeWs.all).toHaveLength(1);
    vi.advanceTimersByTime(10); // reconnect fires after the base backoff delay
    expect(FakeWs.all).toHaveLength(2);
  });

  it('a pong message counts as liveness and keeps the watchdog from tripping', () => {
    const feed = createHlFeed({
      wsFactory: (u) => new FakeWs(u),
      pingMs: 1_000,
      reconnectBaseMs: 10,
    });
    feed.start();
    latest().open();
    vi.advanceTimersByTime(1_000);
    latest().emit({ channel: 'pong' }); // resets lastMsgAt
    vi.advanceTimersByTime(1_000);
    expect(FakeWs.all).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    // elapsed since the pong is now 2_000: still within budget, no reconnect yet
    expect(FakeWs.all).toHaveLength(1);
  });

  it('does not reset the backoff exponent merely on open, only after the first message', () => {
    const feed = createHlFeed({
      wsFactory: (u) => new FakeWs(u),
      reconnectBaseMs: 100,
      reconnectMaxMs: 100_000,
    });
    feed.start();
    latest().open();
    latest().close(); // opened without ever receiving a message; attempt 0 -> delay 100
    vi.advanceTimersByTime(100);
    expect(FakeWs.all).toHaveLength(2);
    latest().open();
    latest().close(); // again no message; attempt 1 -> delay 200
    vi.advanceTimersByTime(199);
    expect(FakeWs.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWs.all).toHaveLength(3);
    latest().open();
    latest().close(); // again no message; attempt 2 -> delay 400
    vi.advanceTimersByTime(399);
    expect(FakeWs.all).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeWs.all).toHaveLength(4);
  });

  it('stop() resets the reconnect backoff exponent', () => {
    // Never opens any socket, so `attempt` can only be reset by stop() itself,
    // not by the onopen handler (which also resets it to 0).
    const feed = createHlFeed({
      wsFactory: (u) => new FakeWs(u),
      reconnectBaseMs: 100,
      reconnectMaxMs: 100_000,
    });
    feed.start();
    latest().close(); // attempt 0 -> delay 100, attempt becomes 1
    vi.advanceTimersByTime(100);
    expect(FakeWs.all).toHaveLength(2);
    latest().close(); // attempt 1 -> delay 200, attempt becomes 2; reconnect not yet fired
    feed.stop(); // cancels the pending 200ms reconnect and should reset attempt to 0
    expect(FakeWs.all).toHaveLength(2);
    feed.start(); // reconnects immediately
    expect(FakeWs.all).toHaveLength(3);
    latest().close(); // if attempt was reset, delay is 100 again (not 400)
    vi.advanceTimersByTime(99);
    expect(FakeWs.all).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeWs.all).toHaveLength(4);
  });
});
