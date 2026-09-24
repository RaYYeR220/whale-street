import type { Holding } from '@whale-street/core';
import { describe, expect, it } from 'vitest';
import { BOTS, createBotRunner, momentumLookbackMs, TAPE_WINDOW_MS } from '../src/bots/runner';
import { type BotCompany, type BotView, cohortAlignment, decide } from '../src/bots/strategies';
import { HOUR_MS } from '../src/dates';
import type { MoodSkew } from '../src/ingest/mood';
import { silentLogger } from '../src/log';
import { createExchange } from '../src/services/exchange';
import { createPlayersService } from '../src/services/players';
import { createSeasonService } from '../src/services/seasons';
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
const cohortOf = (smartSkew: number | null): MoodSkew => ({ smartSkew, whaleSkew: null });
const view = (over: Partial<BotView>): BotView => ({
  cash: 10_000,
  holdings: {},
  companies: [],
  mood: new Map(),
  marks: {},
  rand: () => 0.5,
  valueBuysDips: false,
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

  it('cohort alignment follows smart-trader positioning per coin', () => {
    const mood = new Map([
      ['BTC', cohortOf(0.8)],
      ['ETH', cohortOf(-0.8)],
      ['SOL', cohortOf(null)],
    ]);
    const aligned = co({ id: 'a', positions: [pos('BTC', 1, 100), pos('ETH', -1, 100)] });
    const against = co({ id: 'b', positions: [pos('BTC', -1, 100)] });
    expect(cohortAlignment(aligned, mood, {})).toBe(1);
    expect(cohortAlignment(against, mood, {})).toBe(-1);
    expect(cohortAlignment(co({ id: 'c', positions: [pos('SOL', 1, 1)] }), mood, {})).toBeNull();
    // An unknown skew is no signal: the coin is left out, whatever its size.
    const mixed = co({ id: 'd', positions: [pos('BTC', 1, 100), pos('SOL', 100, 100)] });
    expect(cohortAlignment(mixed, mood, {})).toBe(1);
    expect(decide('cohort', view({ companies: [against, aligned], mood }))).toEqual({
      ticker: 'A',
      side: 'BUY',
      cash: 300,
    });
    expect(
      decide('cohort', view({ companies: [against], mood, holdings: { b: long(2) } })),
    ).toEqual({ ticker: 'B', side: 'SELL', qty: 2 });
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
  it('creates five labelled bot players and trades through the exchange every 20–40 s, never while idle', () => {
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
    runner.onTick(now);
    for (let i = 0; i < 41; i++) runner.onTick(now + (i + 1) * 1_000);
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
