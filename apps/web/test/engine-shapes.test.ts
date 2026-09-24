/**
 * The REST shapes the engine assembles inline (api/rest.ts maps rows into them, so no engine type
 * names them): their keys, read from the real routes of a real engine, are exactly the keys the
 * web types declare. The compile-time contract covers every other payload.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { bearer, type TestEngine, testEngine } from '../../engine/test/helpers/engine';
import { addCompany } from '../../engine/test/helpers/world';
import type {
  HistoryPoint,
  PublicPlayerView,
  SeasonResultView,
  TradeRowView,
} from '../lib/api-types';

/** Every key of T, spelled out: a missing or extra key does not compile. */
const keysOf = <T>(k: Record<keyof T, true>): string[] => Object.keys(k).sort();

const HISTORY = keysOf<HistoryPoint>({ t: true, nav: true, price: true });
const TRADE = keysOf<TradeRowView>({
  id: true,
  playerId: true,
  seasonId: true,
  companyId: true,
  side: true,
  qty: true,
  cash: true,
  avgPrice: true,
  nav: true,
  multBefore: true,
  multAfter: true,
  forced: true,
  writeOffUsd: true,
  at: true,
  ticker: true,
});
const RESULT = keysOf<SeasonResultView>({ rank: true, netWorth: true, handle: true, kind: true });
const PUBLIC_PLAYER = keysOf<PublicPlayerView>({
  id: true,
  handle: true,
  kind: true,
  createdAt: true,
  walletLinked: true,
});

let t: TestEngine;
afterEach(async () => {
  await t.app.close();
});

describe('REST shapes the engine assembles inline', () => {
  it('match the web types key for key', async () => {
    t = await testEngine();
    addCompany(t.engine, { id: '0x00000000000000000000000000000000000000a1', ticker: 'AAA' });
    t.clock.advance(61_000);
    t.engine.state.setMarks({}, t.clock.now());
    t.engine.tick();

    const signup = (await t.app.inject({ method: 'POST', url: '/api/players' })).json() as {
      player: { id: string; handle: string };
      token: string;
    };
    const order = await t.app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: bearer(signup.token),
      payload: { ticker: 'AAA', side: 'BUY', cash: 100 },
    });
    expect(order.statusCode).toBe(200);
    t.engine.repos.seasonResults.insertMany([
      { seasonId: 1, playerId: signup.player.id, netWorth: 10_000, rank: 1 },
    ]);

    const history = (await t.app.inject({ url: '/api/companies/AAA/history?minutes=60' })).json();
    expect(history.points.length).toBeGreaterThan(0);
    for (const p of history.points) expect(Object.keys(p).sort()).toEqual(HISTORY);

    const profile = (
      await t.app.inject({ url: `/api/players/${encodeURIComponent(signup.player.handle)}` })
    ).json();
    expect(Object.keys(profile.player).sort()).toEqual(PUBLIC_PLAYER);
    expect(profile.trades.length).toBeGreaterThan(0);
    for (const tr of profile.trades) expect(Object.keys(tr).sort()).toEqual(TRADE);

    const season = (await t.app.inject({ url: '/api/seasons/1' })).json();
    expect(season.results.length).toBe(1);
    for (const r of season.results) expect(Object.keys(r).sort()).toEqual(RESULT);
  });
});
