import { multiplier, PARAMS } from '@whale-street/core';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../src/log';
import { createExchange } from '../src/services/exchange';
import { createPlayersService } from '../src/services/players';
import { createSeasonService } from '../src/services/seasons';
import { testEngine } from './helpers/engine';
import { addCompany, makeWorld } from './helpers/world';

const A = '0x00000000000000000000000000000000000000a1' as const;
const B = '0x00000000000000000000000000000000000000b2' as const;

function setup() {
  const w = makeWorld();
  const seasons = createSeasonService({ ...w, seasonDays: 7 });
  const exchange = createExchange({ ...w, seasons });
  const players = createPlayersService(w);
  const alice = players.create('human').player;
  const bob = players.create('human').player;
  const rt = addCompany(w, { id: A, ticker: 'AAA' });
  w.clock.advance(61_000);
  return { w, seasons, exchange, players, alice, bob, rt };
}

describe('exchange', () => {
  it('BUY by quantity debits cash, records the trade, moves the pool and prints to the tape', () => {
    const { w, exchange, alice, rt } = setup();
    const r = exchange.placeOrder(alice.id, { ticker: 'aaa', side: 'BUY', qty: 10 });
    if (!r.ok) throw new Error(r.message);
    expect(r.fill.ticker).toBe('AAA');
    expect(r.portfolio.cash).toBeCloseTo(PARAMS.seasonStartCash - r.fill.cash, 8);
    expect(r.portfolio.holdings[0]).toMatchObject({ ticker: 'AAA', longQty: 10 });
    expect(multiplier(rt.pool)).toBeGreaterThan(1);
    expect(w.repos.companies.get(A)?.poolX).toBe(rt.pool.x);
    expect(w.repos.trades.recent(1)[0]).toMatchObject({ side: 'BUY', qty: 10, forced: false });
    const tape = w.events.find((e) => e.t === 'tape');
    expect(tape?.t === 'tape' && tape.trade.handle).toBe(alice.handle);
    expect(w.events.some((e) => e.t === 'player' && e.playerId === alice.id)).toBe(true);
  });

  it('BUY by cash, then SELL, SHORT and COVER', () => {
    const { exchange, alice } = setup();
    const b = exchange.placeOrder(alice.id, { ticker: 'AAA', side: 'BUY', cash: 500 });
    if (!b.ok) throw new Error(b.message);
    expect(b.fill.cash).toBeLessThanOrEqual(500);
    const s = exchange.placeOrder(alice.id, { ticker: 'AAA', side: 'SELL', qty: b.fill.qty });
    expect(s.ok && s.portfolio.holdings).toEqual([]);
    const sh = exchange.placeOrder(alice.id, { ticker: 'AAA', side: 'SHORT', qty: 5 });
    expect(sh.ok && sh.portfolio.holdings[0]?.shortQty).toBe(5);
    const cv = exchange.placeOrder(alice.id, { ticker: 'AAA', side: 'COVER', qty: 5 });
    expect(cv.ok && cv.portfolio.holdings).toEqual([]);
    expect(cv.ok && cv.portfolio.cash).toBeLessThan(PARAMS.seasonStartCash);
  });

  it('rejects with stable codes', () => {
    const { w, exchange, alice, rt } = setup();
    expect(exchange.placeOrder(alice.id, { ticker: 'ZZZ', side: 'BUY', qty: 1 })).toMatchObject({
      ok: false,
      code: 'UNKNOWN_TICKER',
    });
    expect(exchange.placeOrder(alice.id, { ticker: 'AAA', side: 'SELL', cash: 10 })).toMatchObject({
      ok: false,
      code: 'BAD_REQUEST',
    });
    expect(exchange.placeOrder('ghost', { ticker: 'AAA', side: 'BUY', qty: 1 })).toMatchObject({
      ok: false,
      code: 'UNKNOWN_PLAYER',
    });
    expect(exchange.placeOrder(alice.id, { ticker: 'AAA', side: 'BUY', qty: 4_000 })).toMatchObject(
      { ok: false, code: 'INSUFFICIENT_CASH' },
    );
    w.statusOps.halt(rt, 'data', 'test', w.clock.now());
    expect(exchange.placeOrder(alice.id, { ticker: 'AAA', side: 'BUY', qty: 1 })).toMatchObject({
      ok: false,
      code: 'COMPANY_NOT_TRADING',
    });
  });

  it('caps IPO buys at 10% of season cash during the first 60 s', () => {
    const { w, exchange, alice } = setup();
    addCompany(w, { id: B, ticker: 'BBB' });
    expect(
      exchange.placeOrder(alice.id, { ticker: 'BBB', side: 'BUY', cash: 1_500 }),
    ).toMatchObject({ ok: false, code: 'IPO_ALLOCATION_EXCEEDED' });
    const ok = exchange.placeOrder(alice.id, { ticker: 'BBB', side: 'BUY', cash: 900 });
    expect(ok.ok).toBe(true);
    expect(exchange.placeOrder(alice.id, { ticker: 'BBB', side: 'BUY', cash: 200 })).toMatchObject({
      ok: false,
      code: 'IPO_ALLOCATION_EXCEEDED',
    });
    w.clock.advance(60_000);
    expect(exchange.placeOrder(alice.id, { ticker: 'BBB', side: 'BUY', cash: 200 }).ok).toBe(true);
  });

  it('auto-covers a short when the buy-back reaches 95% of collateral', () => {
    const { w, exchange, alice, rt } = setup();
    exchange.placeOrder(alice.id, { ticker: 'AAA', side: 'SHORT', qty: 10 });
    exchange.autoCover(rt, w.clock.now());
    expect(exchange.portfolio(alice.id).holdings).toHaveLength(1);
    rt.nav = { ...rt.nav, nav: 250 };
    exchange.autoCover(rt, w.clock.now());
    expect(exchange.portfolio(alice.id).holdings).toEqual([]);
    expect(w.repos.trades.recent(1)[0]).toMatchObject({ side: 'COVER', forced: true });
  });

  it('stores a forced cover write-off on its trade row and logs it', () => {
    const w = makeWorld();
    const warnings: Array<{ msg: string; data: unknown }> = [];
    const log = {
      ...silentLogger,
      warn: (msg: string, data?: unknown) => warnings.push({ msg, data }),
    };
    const seasons = createSeasonService({ ...w, seasonDays: 7 });
    const exchange = createExchange({ ...w, seasons, log });
    const alice = createPlayersService(w).create('human').player;
    const rt = addCompany(w, { id: A, ticker: 'AAA' });
    w.clock.advance(61_000);
    exchange.placeOrder(alice.id, { ticker: 'AAA', side: 'SHORT', qty: 10 });
    expect(w.repos.trades.recent(1)[0]?.writeOffUsd).toBe(0);
    const collateral = exchange.portfolio(alice.id).holdings[0]?.shortCollateral ?? 0;
    // The buy-back now costs far more than the collateral the short put up.
    rt.nav = { ...rt.nav, nav: 1_000 };
    exchange.autoCover(rt, w.clock.now());
    const cover = w.repos.trades.recent(1)[0];
    expect(cover).toMatchObject({ side: 'COVER', forced: true });
    expect(cover?.writeOffUsd).toBeGreaterThan(0);
    expect(cover?.writeOffUsd).toBeCloseTo((cover?.cash ?? 0) - collateral, 6);
    expect(warnings).toMatchObject([
      { msg: 'forced cover write-off', data: { writeOffUsd: cover?.writeOffUsd } },
    ]);
  });

  it('the engine exchange writes its write-off warning to the engine logger', async () => {
    const warnings: string[] = [];
    const t = await testEngine({ log: { ...silentLogger, warn: (msg) => warnings.push(msg) } });
    const rt = addCompany(t.engine, { id: A, ticker: 'AAA' });
    t.clock.advance(61_000);
    t.engine.state.setMarks({}, t.clock.now());
    t.engine.tick();
    const { player } = t.engine.players.create('human');
    expect(
      t.engine.exchange.placeOrder(player.id, { ticker: 'AAA', side: 'SHORT', qty: 10 }).ok,
    ).toBe(true);
    rt.nav = { ...rt.nav, nav: 1_000 };
    t.engine.exchange.autoCover(rt, t.clock.now());
    expect(warnings).toContain('forced cover write-off');
    await t.app.close();
  });

  it('quotes without trading and ranks the leaderboard by net worth', () => {
    const { exchange, alice, bob } = setup();
    const q = exchange.quote('AAA', 'BUY', 10);
    expect(q.ok && q.priceAfter).toBeGreaterThan(q.ok ? q.price : 0);
    exchange.placeOrder(alice.id, { ticker: 'AAA', side: 'BUY', qty: 20 });
    exchange.placeOrder(bob.id, { ticker: 'AAA', side: 'BUY', qty: 5 });
    const lb = exchange.leaderboard(10);
    expect(lb.map((r) => r.handle)).toEqual([alice.handle, bob.handle]);
    expect(lb[0]?.rank).toBe(1);
    expect(exchange.holders(A).map((h) => h.handle)).toEqual([alice.handle, bob.handle]);
  });
});

describe('seasons', () => {
  it('creates season 1, then settles every holding at the share price and ranks results on rollover', () => {
    const { w, seasons, exchange, alice, bob, rt } = setup();
    const s1 = seasons.ensure(w.clock.now());
    expect(s1.id).toBe(1);
    exchange.placeOrder(alice.id, { ticker: 'AAA', side: 'BUY', qty: 50 });
    exchange.placeOrder(bob.id, { ticker: 'AAA', side: 'SHORT', qty: 10 });
    const price = w.state.price(rt);
    const aliceBefore = exchange.portfolio(alice.id);
    expect(seasons.maybeRollover(w.clock.now())).toBe(false);
    w.clock.advance(7 * 86_400_000);
    expect(seasons.maybeRollover(w.clock.now())).toBe(true);
    const results = w.repos.seasonResults.forSeason(1);
    expect(results.map((r) => r.rank)).toEqual([1, 2]);
    const aliceResult = results.find((r) => r.playerId === alice.id);
    expect(aliceResult?.netWorth).toBeCloseTo(aliceBefore.cash + 50 * price, 6);
    expect(w.repos.holdings.forSeason(1)).toEqual([]);
    expect(w.repos.seasons.current()?.id).toBe(2);
    expect(exchange.portfolio(alice.id)).toMatchObject({
      seasonId: 2,
      cash: PARAMS.seasonStartCash,
      holdings: [],
    });
  });

  it('never settles a holding at a made-up price: a company missing from state is skipped and logged', () => {
    const w = makeWorld();
    const errors: Array<{ msg: string; data: unknown }> = [];
    const log = {
      ...silentLogger,
      error: (msg: string, data?: unknown) => errors.push({ msg, data }),
    };
    const seasons = createSeasonService({ ...w, seasonDays: 7, log });
    const exchange = createExchange({ ...w, seasons });
    const players = createPlayersService(w);
    const alice = players.create('human').player;
    const a = addCompany(w, { id: A, ticker: 'AAA' });
    addCompany(w, { id: B, ticker: 'BBB' });
    w.clock.advance(61_000);
    seasons.ensure(w.clock.now());
    exchange.placeOrder(alice.id, { ticker: 'AAA', side: 'BUY', qty: 10 });
    exchange.placeOrder(alice.id, { ticker: 'BBB', side: 'BUY', qty: 10 });
    const cash = exchange.portfolio(alice.id).cash;
    const priceA = w.state.price(a);
    const held = w.repos.holdings.forSeason(1).find((h) => h.companyId === B);
    w.state.companies.delete(B);
    w.clock.advance(7 * 86_400_000);

    expect(seasons.maybeRollover(w.clock.now())).toBe(true);
    // The known company settles at its share price; the missing one is carried as it was.
    expect(w.repos.holdings.forSeason(1)).toEqual([held]);
    const settles = w.repos.trades.recent(10).filter((t) => t.side === 'SETTLE');
    expect(settles.map((t) => t.companyId)).toEqual([A]);
    expect(w.repos.seasonResults.forSeason(1)[0]?.netWorth).toBeCloseTo(cash + 10 * priceA, 6);
    expect(errors).toMatchObject([{ data: { company: B } }]);
  });
});
