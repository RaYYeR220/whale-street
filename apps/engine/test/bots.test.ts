import type { Holding } from '@whale-street/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOTS, createBotRunner, momentumLookbackMs, TAPE_WINDOW_MS } from '../src/bots/runner';
import { type BotCompany, type BotView, cohortAlignment, decide } from '../src/bots/strategies';
import { loadConfig } from '../src/config';
import { HOUR_MS } from '../src/dates';
import { openDb } from '../src/db/index';
import { createEngine } from '../src/engine';
import { MOOD_STALE_MS, type StreetMood } from '../src/ingest/mood';
import { silentLogger } from '../src/log';
import { createExchange } from '../src/services/exchange';
import { createPlayersService } from '../src/services/players';
import { createSeasonService } from '../src/services/seasons';
import { FakeFeed, FakeInfo } from './helpers/fake-hl';
import { FakeNansen } from './helpers/fake-nansen';
import { addCompany, makeWorld, pos } from './helpers/world';

const NOW = 1_790_000_000_000;
const co = (over: Partial<BotCompany> & { id: string }): BotCompany => ({
  ticker: over.id.toUpperCase(),
  status: 'ACTIVE',
  mult: 1,
  hp: 1,
  nav: 100,
  price: 100,
  positions: [],
  navLookback: null,
  nav5mAgo: null,
  heldSince: null,
  ...over,
});
const long = (qty: number): Holding => ({
  longQty: qty,
  longCost: qty * 100,
  shortQty: 0,
  shortCollateral: 0,
});
const short = (qty: number): Holding => ({
  longQty: 0,
  longCost: 0,
  shortQty: qty,
  shortCollateral: qty * 200,
});
const cohortOf = (smartSkew: number | null, asOf: number = NOW): StreetMood => ({
  smartSkew,
  whaleSkew: null,
  asOf,
});
const view = (over: Partial<BotView>): BotView => ({
  cash: 10_000,
  holdings: {},
  companies: [],
  mood: new Map(),
  marks: {},
  rand: () => 0.5,
  valueBuysDips: false,
  vultureShortsSlides: false,
  now: NOW,
  lookbackMs: 150_000,
  ...over,
});

describe('bot strategies', () => {
  it('value buys the deepest discount and sells premiums first', () => {
    expect(
      decide(
        'value',
        view({ companies: [co({ id: 'a', mult: 0.96 }), co({ id: 'b', mult: 0.9 })] }),
      ),
    ).toEqual({ ticker: 'B', side: 'BUY', cash: 300 });
    expect(
      decide(
        'value',
        view({
          companies: [co({ id: 'a', mult: 1.1 }), co({ id: 'b', mult: 0.9 })],
          holdings: { a: long(7) },
        }),
      ),
    ).toEqual({ ticker: 'A', side: 'SELL', qty: 7 });
    expect(
      decide('value', view({ companies: [co({ id: 'a', mult: 0.9, status: 'HALTED' })] })),
    ).toBeNull();
  });

  it('value also buys healthy NAV dips and sells recoveries where only the desk makes hype (REPLAY)', () => {
    const dip = co({ id: 'a', nav: 97, navLookback: 100, hp: 0.8 });
    const deeper = co({ id: 'b', nav: 90, navLookback: 100, hp: 0.9 });
    const sick = co({ id: 'c', nav: 80, navLookback: 100, hp: 0.4 });
    // LIVE: hype only.
    expect(decide('value', view({ companies: [dip, deeper] }))).toBeNull();
    const replay = (over: Partial<BotView>) => view({ valueBuysDips: true, ...over });
    expect(decide('value', replay({ companies: [dip, deeper, sick] }))).toEqual({
      ticker: 'B',
      side: 'BUY',
      cash: 300,
    });
    // A hype discount still comes first.
    expect(
      decide('value', replay({ companies: [deeper, co({ id: 'd', mult: 0.95 })] })),
    ).toMatchObject({ ticker: 'D', side: 'BUY' });
    expect(decide('value', replay({ companies: [sick] }))).toBeNull();
    expect(
      decide('value', replay({ companies: [co({ id: 'a', nav: 99, navLookback: 100 })] })),
    ).toBeNull();
    // Recovered (+2% over the lookback): sells.
    expect(
      decide(
        'value',
        replay({
          companies: [co({ id: 'a', nav: 103, navLookback: 100 })],
          holdings: { a: long(5) },
        }),
      ),
    ).toEqual({ ticker: 'A', side: 'SELL', qty: 5 });
  });

  it('vulture shorts the weakest HP and covers on recovery', () => {
    expect(
      decide(
        'vulture',
        view({
          companies: [co({ id: 'a', hp: 0.2, price: 50 }), co({ id: 'b', hp: 0.1, price: 25 })],
        }),
      ),
    ).toEqual({ ticker: 'B', side: 'SHORT', qty: 12 });
    expect(
      decide('vulture', view({ companies: [co({ id: 'a', hp: 0.6 })], holdings: { a: short(4) } })),
    ).toEqual({ ticker: 'A', side: 'COVER', qty: 4 });
  });

  it('vulture also shorts the steepest NAV slide where nobody is near liquidation (REPLAY), covering once it turns', () => {
    const slide = co({ id: 'a', nav: 97, navLookback: 100, price: 50 });
    const steeper = co({ id: 'b', nav: 95, navLookback: 100, price: 25 });
    const calm = co({ id: 'c', nav: 99, navLookback: 100 });
    // LIVE: distress only.
    expect(decide('vulture', view({ companies: [slide, steeper] }))).toBeNull();
    const replay = (over: Partial<BotView>) => view({ vultureShortsSlides: true, ...over });
    expect(decide('vulture', replay({ companies: [slide, steeper, calm] }))).toEqual({
      ticker: 'B',
      side: 'SHORT',
      qty: 12,
    });
    // A trader near liquidation still comes first.
    expect(
      decide('vulture', replay({ companies: [steeper, co({ id: 'd', hp: 0.2, price: 50 })] })),
    ).toMatchObject({ ticker: 'D', side: 'SHORT' });
    expect(decide('vulture', replay({ companies: [calm] }))).toBeNull();
    const held = (over: Partial<BotCompany>) =>
      decide(
        'vulture',
        replay({
          companies: [co({ id: 'a', heldSince: NOW - 60_000, ...over })],
          holdings: { a: short(4) },
        }),
      );
    const cover = { ticker: 'A', side: 'COVER', qty: 4 };
    // Still sliding: keeps the short.
    expect(held({ nav: 97, navLookback: 100 })).toBeNull();
    // The slide turned, it has held past its lookback, or it opened before a REPLAY wrap: covers.
    expect(held({ nav: 100.5, navLookback: 100 })).toEqual(cover);
    expect(held({ nav: 97, navLookback: 100, heldSince: NOW - 150_001 })).toEqual(cover);
    expect(held({ nav: 97, navLookback: 100, heldSince: NOW + 30_000 })).toEqual(cover);
  });

  it('cohort alignment follows smart-trader positioning per coin', () => {
    const mood = new Map([
      ['BTC', cohortOf(0.8)],
      ['ETH', cohortOf(-0.8)],
      ['SOL', cohortOf(null)],
    ]);
    const aligned = co({ id: 'a', positions: [pos('BTC', 1, 100), pos('ETH', -1, 100)] });
    const against = co({ id: 'b', positions: [pos('BTC', -1, 100)] });
    expect(cohortAlignment(aligned, mood, {}, NOW)).toBe(1);
    expect(cohortAlignment(against, mood, {}, NOW)).toBe(-1);
    expect(
      cohortAlignment(co({ id: 'c', positions: [pos('SOL', 1, 1)] }), mood, {}, NOW),
    ).toBeNull();
    // An unknown skew is no signal: the coin is left out, whatever its size.
    const mixed = co({ id: 'd', positions: [pos('BTC', 1, 100), pos('SOL', 100, 100)] });
    expect(cohortAlignment(mixed, mood, {}, NOW)).toBe(1);
    expect(decide('cohort', view({ companies: [against, aligned], mood }))).toEqual({
      ticker: 'A',
      side: 'BUY',
      cash: 300,
    });
    expect(
      decide('cohort', view({ companies: [against], mood, holdings: { b: long(2) } })),
    ).toEqual({ ticker: 'B', side: 'SELL', qty: 2 });
  });

  it('cohort alignment ignores mood readings older than 30 minutes', () => {
    const fresh = new Map([['BTC', cohortOf(0.8, NOW - MOOD_STALE_MS)]]);
    const stale = new Map([['BTC', cohortOf(0.8, NOW - MOOD_STALE_MS - 1)]]);
    const c = co({ id: 'a', positions: [pos('BTC', 1, 100)] });
    // Exactly at the limit is still fresh; one ms past it is unknown, same as no reading at all.
    expect(cohortAlignment(c, fresh, {}, NOW)).toBe(1);
    expect(cohortAlignment(c, stale, {}, NOW)).toBeNull();
    expect(cohortAlignment(c, new Map(), {}, NOW)).toBeNull();
  });

  it('cohort sells a still-aligned holding held past its lookback, or bought before a REPLAY wrap', () => {
    const mood = new Map([['BTC', cohortOf(0.8)]]);
    const held = (heldSince: number | null) =>
      decide(
        'cohort',
        view({
          companies: [co({ id: 'a', positions: [pos('BTC', 1, 100)], heldSince })],
          mood,
          holdings: { a: long(2) },
        }),
      );
    const sell = { ticker: 'A', side: 'SELL', qty: 2 };
    expect(held(NOW - 60_000)).toBeNull();
    expect(held(NOW - 150_001)).toEqual(sell);
    expect(held(NOW + 30_000)).toEqual(sell);
    expect(held(null)).toEqual(sell);
  });

  it('momentum follows the NAV trend over its lookback', () => {
    expect(
      decide('momentum', view({ companies: [co({ id: 'a', nav: 103, navLookback: 100 })] })),
    ).toEqual({ ticker: 'A', side: 'BUY', cash: 300 });
    expect(
      decide(
        'momentum',
        view({ companies: [co({ id: 'a', nav: 97, navLookback: 100 })], holdings: { a: long(3) } }),
      ),
    ).toEqual({ ticker: 'A', side: 'SELL', qty: 3 });
    expect(
      decide('momentum', view({ companies: [co({ id: 'a', nav: 101, navLookback: null })] })),
    ).toBeNull();
  });

  it('momentum exits when its signal reverses or once it has held longer than its lookback', () => {
    const held = (over: Partial<BotCompany>) =>
      decide(
        'momentum',
        view({
          companies: [co({ id: 'a', heldSince: NOW - 60_000, ...over })],
          holdings: { a: long(3) },
        }),
      );
    const sell = { ticker: 'A', side: 'SELL', qty: 3 };
    // Bought a minute ago on an up-trend that still holds (or has no history yet): keeps it.
    expect(held({ nav: 101, navLookback: 100 })).toBeNull();
    expect(held({ nav: 101, navLookback: null })).toBeNull();
    // The trend turned down, even mildly: the signal it bought on is gone.
    expect(held({ nav: 99.5, navLookback: 100 })).toEqual(sell);
    // Held past its lookback window, whatever the trend.
    expect(held({ nav: 101, navLookback: 100, heldSince: NOW - 150_001 })).toEqual(sell);
    // Opened after "now": bought in an earlier REPLAY loop (the clock went back), so it is old.
    expect(held({ nav: 101, navLookback: null, heldSince: NOW + 30_000 })).toEqual(sell);
    // A position without a known opening trade is treated as old.
    expect(held({ nav: 101, navLookback: 100, heldSince: null })).toEqual(sell);
  });

  it('momentum looks back 1 h in LIVE and a quarter of the loop (at most 1 h) in REPLAY', () => {
    expect(momentumLookbackMs(null)).toBe(HOUR_MS);
    expect(momentumLookbackMs(600_000)).toBe(150_000);
    expect(momentumLookbackMs(8 * HOUR_MS)).toBe(HOUR_MS);
  });

  it('the tape reader trades small in the 5-minute NAV direction of a random active company', () => {
    const up = co({ id: 'a', nav: 101, nav5mAgo: 100, price: 50 });
    const down = co({ id: 'b', nav: 99, nav5mAgo: 100, price: 50 });
    // rand 0.5: picks the second of two companies; the stake is 1.5% of cash.
    expect(decide('tape', view({ companies: [down, up] }))).toEqual({
      ticker: 'A',
      side: 'BUY',
      cash: 150,
    });
    expect(decide('tape', view({ companies: [up, down] }))).toEqual({
      ticker: 'B',
      side: 'SHORT',
      qty: 3,
    });
    // Against its position: exits first (the exchange refuses to flip a position in one order).
    expect(decide('tape', view({ companies: [up, down], holdings: { b: long(4) } }))).toEqual({
      ticker: 'B',
      side: 'SELL',
      qty: 4,
    });
    expect(decide('tape', view({ companies: [down, up], holdings: { a: short(2) } }))).toEqual({
      ticker: 'A',
      side: 'COVER',
      qty: 2,
    });
    // Keeps adding while the position is small; at 10% of its cash it trims half instead.
    expect(decide('tape', view({ companies: [down, up], holdings: { a: long(2) } }))).toEqual({
      ticker: 'A',
      side: 'BUY',
      cash: 150,
    });
    expect(decide('tape', view({ companies: [down, up], holdings: { a: long(20) } }))).toEqual({
      ticker: 'A',
      side: 'SELL',
      qty: 10,
    });
    expect(decide('tape', view({ companies: [up, down], holdings: { b: short(20) } }))).toEqual({
      ticker: 'B',
      side: 'COVER',
      qty: 10,
    });
    // No history, a flat NAV, or nothing tradable: no order.
    expect(decide('tape', view({ companies: [co({ id: 'a', nav5mAgo: null })] }))).toBeNull();
    expect(decide('tape', view({ companies: [co({ id: 'a', nav5mAgo: 100 })] }))).toBeNull();
    expect(
      decide('tape', view({ companies: [co({ ...up, id: 'a', status: 'HALTED' })] })),
    ).toBeNull();
  });
});

describe('bot runner', () => {
  it('creates five labelled bot players and trades through the exchange (a first round within 5 s, then every 20–40 s), never while idle', () => {
    const w = makeWorld();
    const seasons = createSeasonService({ ...w, seasonDays: 7 });
    const exchange = createExchange({ ...w, seasons });
    const players = createPlayersService(w);
    const runner = createBotRunner({ ...w, exchange, players, log: silentLogger });
    const rt = addCompany(w, { id: '0x00000000000000000000000000000000000000a1', ticker: 'AAA' });
    rt.pool = { x: 5_500, y: 4_500, l0: 5_000 };
    rt.ipoUntil = 0;
    expect(BOTS.map((b) => players.get(b.id)?.kind)).toEqual(['bot', 'bot', 'bot', 'bot', 'bot']);
    expect(players.get('bot-tape')?.handle).toBe('Tape Reader');

    w.state.flags.idle = true;
    for (let i = 0; i < 60; i++) {
      w.clock.advance(1_000);
      runner.onTick(w.clock.now());
    }
    expect(w.repos.trades.recent(10)).toEqual([]);

    w.state.flags.idle = false;
    runner.onTick(w.clock.now());
    for (let i = 0; i < 41; i++) {
      w.clock.advance(1_000);
      runner.onTick(w.clock.now());
    }
    const trades = w.repos.trades.recent(10);
    expect(trades.map((t) => [t.playerId, t.side])).toEqual([['bot-value', 'BUY']]);
    const tape = w.events.find((e) => e.t === 'tape');
    expect(tape?.t === 'tape' && tape.trade).toMatchObject({ handle: 'Value Fund', kind: 'bot' });
  });

  it('feeds momentum and the tape reader NAV from their own lookbacks', () => {
    const w = makeWorld();
    const seasons = createSeasonService({ ...w, seasonDays: 7 });
    const exchange = createExchange({ ...w, seasons });
    const players = createPlayersService(w);
    const runner = createBotRunner({
      ...w,
      exchange,
      players,
      log: silentLogger,
      momentumLookbackMs: 150_000,
    });
    const rt = addCompany(w, { id: '0x00000000000000000000000000000000000000a1', ticker: 'AAA' });
    rt.ipoUntil = 0;
    const now = w.clock.now();
    w.repos.navPoints.insert({ companyId: rt.id, t: now - 150_000, nav: 100, price: 100 });
    w.repos.navPoints.insert({ companyId: rt.id, t: now - TAPE_WINDOW_MS, nav: 104, price: 104 });
    rt.nav = { ...rt.nav, nav: 103 };
    // The first decision round comes within 5 s.
    runner.onTick(now);
    for (let i = 0; i < 5; i++) runner.onTick(now + (i + 1) * 1_000);
    const sides = w.repos.trades
      .recent(10)
      .map((t) => [t.playerId, t.side])
      .sort();
    // +3% over momentum's 150 s: a BUY; −1% over the tape's 5 minutes: a small SHORT.
    expect(sides).toEqual([
      ['bot-momentum', 'BUY'],
      ['bot-tape', 'SHORT'],
    ]);
  });

  it('momentum sells a position held past its lookback, and one opened before a REPLAY wrap', () => {
    const w = makeWorld();
    const seasons = createSeasonService({ ...w, seasonDays: 7 });
    const exchange = createExchange({ ...w, seasons });
    const players = createPlayersService(w);
    const runner = createBotRunner({
      ...w,
      exchange,
      players,
      log: silentLogger,
      momentumLookbackMs: 150_000,
    });
    const rt = addCompany(w, { id: '0x00000000000000000000000000000000000000a1', ticker: 'AAA' });
    rt.ipoUntil = 0;
    const momentumSides = () =>
      w.repos.trades
        .recent(20)
        .filter((t) => t.playerId === 'bot-momentum')
        .map((t) => t.side)
        .reverse();
    const run = (seconds: number) => {
      for (let i = 0; i < seconds; i++) {
        w.clock.advance(1_000);
        runner.onTick(w.clock.now());
      }
    };
    // Momentum holds AAA (no NAV history: no trend signal either way).
    expect(exchange.placeOrder('bot-momentum', { ticker: 'AAA', side: 'BUY', cash: 300 }).ok).toBe(
      true,
    );
    runner.onTick(w.clock.now());
    run(100);
    expect(momentumSides()).toEqual(['BUY']);
    run(90);
    expect(momentumSides()).toEqual(['BUY', 'SELL']);

    // Bought again, then the REPLAY clock goes back 5 minutes: the position is from a later
    // point of an earlier loop, so it is old.
    const boughtAt = w.clock.now();
    expect(exchange.placeOrder('bot-momentum', { ticker: 'AAA', side: 'BUY', cash: 300 }).ok).toBe(
      true,
    );
    w.clock.t = boughtAt - 300_000;
    runner.reset();
    runner.onTick(w.clock.now());
    run(41);
    expect(momentumSides()).toEqual(['BUY', 'SELL', 'BUY', 'SELL']);
  });
});

describe('bot runner timing', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the day promptly: a first round within 5 s of boot, of a wake and of the pause clearing', async () => {
    vi.useFakeTimers({ now: NOW });
    const feed = new FakeFeed();
    const config = loadConfig({ MODE: 'replay' }, () => {
      throw new Error('no env file in tests');
    });
    const engine = createEngine({
      config,
      db: openDb(':memory:'),
      nansen: new FakeNansen(),
      trading: null,
      hl: { feed, info: new FakeInfo() },
      clock: { now: () => Date.now() },
      log: silentLogger,
      replay: null,
    });
    const rt = addCompany(engine, {
      id: '0x00000000000000000000000000000000000000a1',
      ticker: 'AAA',
    });
    rt.ipoUntil = 0;
    /** The Value Fund buys a hype discount when it is flat and sells its holding at a premium. */
    const discount = () => {
      rt.pool = { x: 5_500, y: 4_500, l0: 5_000 };
    };
    const premium = () => {
      rt.pool = { x: 4_500, y: 5_500, l0: 5_000 };
    };
    const botTrades = () =>
      engine.repos.trades.recent(1_000).filter((t) => t.playerId.startsWith('bot-')).length;
    /** Seconds pass on the 1 Hz engine interval; the Hyperliquid feed keeps the marks fresh. */
    const run = async (seconds: number, marks = true) => {
      for (let i = 0; i < seconds; i++) {
        if (marks) feed.emitMids({ BTC: 60_000 }, Date.now());
        await vi.advanceTimersByTimeAsync(1_000);
      }
    };
    discount();
    engine.start();
    engine.idle.clientConnected(Date.now());

    // Boot: the market opens on the first fresh tick and a bot trades within 5 s.
    await run(5);
    expect(botTrades(), 'bot trades 5 s after boot').toBeGreaterThan(0);

    // Nobody watching: IDLE after two minutes, and no trades while idle.
    engine.idle.clientDisconnected(Date.now());
    await run(130);
    expect(engine.state.flags.idle).toBe(true);
    const beforeWake = botTrades();
    await run(60);
    expect(botTrades()).toBe(beforeWake);

    // A viewer arrives: within 5 s of the wake a bot trades again.
    premium();
    engine.idle.clientConnected(Date.now());
    await run(5);
    expect(botTrades(), 'bot trades 5 s after a wake').toBeGreaterThan(beforeWake);

    // The feed stalls (MARKET_PAUSED); once fresh marks return, a bot trades within 5 s of the
    // first fresh tick instead of having spent its round on a refused order.
    await run(45);
    discount();
    await run(15, false);
    expect(engine.state.paused()).toBe(true);
    const beforeResume = botTrades();
    await run(5);
    expect(engine.state.paused()).toBe(false);
    expect(botTrades(), 'bot trades 5 s after the pause clears').toBeGreaterThan(beforeResume);
    await engine.stop();
  });
});
