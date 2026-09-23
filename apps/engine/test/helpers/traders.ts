import type { Address } from '@whale-street/core';
import type { PerpTradeRow } from '@whale-street/nansen';
import { DAY_MS } from '../../src/dates';
import type { FakeInfo } from './fake-hl';
import type { FakeNansen } from './fake-nansen';
import { pos } from './world';

export const tradeRow = (over: Partial<PerpTradeRow> = {}): PerpTradeRow => ({
  at: 0,
  coin: 'BTC',
  side: 'Long',
  action: 'Close',
  price: 60_000,
  size: 1,
  valueUsd: 60_000,
  closedPnl: 0,
  feeUsd: 0,
  ...over,
});

/** A trader the committee approves: 200 days, 100 closed trades, $600k equity, long 2 BTC, no hedges. */
export function programCleanTrader(n: FakeNansen, info: FakeInfo, a: Address, now: number): void {
  n.firstTrades.set(a, [tradeRow({ at: now - 200 * DAY_MS })]);
  n.topTrades.set(a, [tradeRow({ closedPnl: 50_000 })]);
  n.pnl.set(a, {
    realizedPnlUsd: 400_000,
    feesUsd: 20_000,
    winRate: 0.64,
    closedTrades: 100,
    tradedTimes: 900,
    topCoins: ['BTC', 'HYPE'],
  });
  n.positions.set(a, {
    positions: [pos('BTC', 2, 60_000, 40_000)],
    accountValue: 600_000,
    time: null,
  });
  info.vaults.set(a, false);
}

/** Same trader, but its first funder holds an offsetting 1.5 BTC short (negative control). */
export function programHedgedTrader(
  n: FakeNansen,
  info: FakeInfo,
  a: Address,
  linked: Address,
  now: number,
): void {
  programCleanTrader(n, info, a, now);
  n.funders.set(a, { funder: linked, funderName: null });
  info.states.set(linked, {
    positions: [pos('BTC', -1.5, 60_000, 80_000)],
    accountValue: 200_000,
    time: null,
  });
}
