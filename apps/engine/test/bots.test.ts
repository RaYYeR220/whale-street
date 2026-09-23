import type { Holding } from '@whale-street/core';
import type { CohortPositioning } from '@whale-street/nansen';
import { describe, expect, it } from 'vitest';
import { BOTS, createBotRunner } from '../src/bots/runner';
import { type BotCompany, type BotView, cohortAlignment, decide } from '../src/bots/strategies';
import { silentLogger } from '../src/log';
import { createExchange } from '../src/services/exchange';
import { createPlayersService } from '../src/services/players';
import { createSeasonService } from '../src/services/seasons';
import { addCompany, makeWorld, pos } from './helpers/world';

const co = (over: Partial<BotCompany> & { id: string }): BotCompany => ({
  ticker: over.id.toUpperCase(),
  status: 'ACTIVE',
  mult: 1,
  hp: 1,
  nav: 100,
  price: 100,
  positions: [],
  navHourAgo: null,
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
const cohortOf = (smartLongs: number, smartShorts: number): CohortPositioning => ({
  smartLongs,
  smartShorts,
  whaleLongs: 0,
  whaleShorts: 0,
  publicLongs: 0,
  publicShorts: 0,
});
const view = (over: Partial<BotView>): BotView => ({
  cash: 10_000,
  holdings: {},
  companies: [],
  mood: new Map(),
  marks: {},
  rand: () => 0.5,
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
      ['BTC', cohortOf(10, 1)],
      ['ETH', cohortOf(1, 10)],
    ]);
    const aligned = co({ id: 'a', positions: [pos('BTC', 1, 100), pos('ETH', -1, 100)] });
    const against = co({ id: 'b', positions: [pos('BTC', -1, 100)] });
    expect(cohortAlignment(aligned, mood, {})).toBe(1);
    expect(cohortAlignment(against, mood, {})).toBe(-1);
    expect(cohortAlignment(co({ id: 'c', positions: [pos('SOL', 1, 1)] }), mood, {})).toBeNull();
    expect(decide('cohort', view({ companies: [against, aligned], mood }))).toEqual({
      ticker: 'A',
      side: 'BUY',
      cash: 300,
    });
    expect(
      decide('cohort', view({ companies: [against], mood, holdings: { b: long(2) } })),
    ).toEqual({ ticker: 'B', side: 'SELL', qty: 2 });
  });

  it('momentum follows the 1-hour NAV trend', () => {
    expect(
      decide('momentum', view({ companies: [co({ id: 'a', nav: 103, navHourAgo: 100 })] })),
    ).toEqual({ ticker: 'A', side: 'BUY', cash: 300 });
    expect(
      decide(
        'momentum',
        view({ companies: [co({ id: 'a', nav: 97, navHourAgo: 100 })], holdings: { a: long(3) } }),
      ),
    ).toEqual({ ticker: 'A', side: 'SELL', qty: 3 });
    expect(
      decide('momentum', view({ companies: [co({ id: 'a', nav: 101, navHourAgo: null })] })),
    ).toBeNull();
  });
});

describe('bot runner', () => {
  it('creates four labelled bot players and trades through the exchange every 20–40 s, never while idle', () => {
    const w = makeWorld();
    const seasons = createSeasonService({ ...w, seasonDays: 7 });
    const exchange = createExchange({ ...w, seasons });
    const players = createPlayersService(w);
    const runner = createBotRunner({ ...w, exchange, players, log: silentLogger });
    const rt = addCompany(w, { id: '0x00000000000000000000000000000000000000a1', ticker: 'AAA' });
    rt.pool = { x: 5_500, y: 4_500, l0: 5_000 };
    rt.ipoUntil = 0;
    expect(BOTS.map((b) => players.get(b.id)?.kind)).toEqual(['bot', 'bot', 'bot', 'bot']);

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
});
