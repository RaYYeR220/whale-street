import { describe, expect, it } from 'vitest';
import type { HoldingView, PositionView } from '../lib/api-types';
import {
  displayStatus,
  headline,
  liqDistance,
  notional,
  openIpoCount,
  portraitStatus,
  toDisplay,
  unrealized,
} from '../lib/company';
import { ipoErrorText, orderErrorText } from '../lib/errors';
import { filingText, foldRepeats, kindOf } from '../lib/filings';
import { avgEntry, holdingPnl, holdingReturn, invested, isShort } from '../lib/portfolio';
import { seriesFromHistory } from '../lib/store';
import { companyView, entry, filing, T0 } from './helpers';

const pos = (o: Partial<PositionView> = {}): PositionView => ({
  coin: 'BTC',
  size: 10,
  entryPx: 100_000,
  liqPx: 80_000,
  leverage: 3,
  marginUsed: 300_000,
  unrealizedPnl: 0,
  mark: 110_000,
  hp: 0.9,
  ...o,
});

describe('company display', () => {
  it('reads positions at the live mark', () => {
    expect(notional(pos())).toBe(1_100_000);
    expect(notional(pos({ mark: null }))).toBe(1_000_000);
    expect(liqDistance(pos())).toBeCloseTo(30_000 / 110_000);
    expect(liqDistance(pos({ liqPx: null }))).toBeNull();
    expect(unrealized(pos())).toEqual({ usd: 100_000, live: true });
    expect(unrealized(pos({ mark: null, unrealizedPnl: 5 }))).toEqual({ usd: 5, live: false });
  });

  it('headlines the biggest position', () => {
    expect(headline([pos({ coin: 'ETH', size: -1, mark: 4000 }), pos()])?.text).toBe('LONG BTC 3x');
    expect(headline([])).toBeNull();
  });

  it('derives the display status, IPO only while the window is open', () => {
    expect(displayStatus('ACTIVE', T0 + 1000, T0)).toBe('ipo');
    expect(displayStatus('ACTIVE', T0 - 1, T0)).toBe('active');
    expect(displayStatus('ACTIVE', T0 + 1000, null)).toBe('active');
    expect(displayStatus('HALTED', T0 + 1000, T0)).toBe('halted');
    expect(portraitStatus('delisted')).toBe('bankrupt');
  });

  it('merges the live entry over the REST view and computes 1h changes', () => {
    const series = seriesFromHistory([
      { t: T0 - 30 * 60_000, nav: 100, price: 100 },
      { t: T0, nav: 110, price: 121 },
    ]);
    const d = toDisplay(entry({ price: 121, nav: 110, mult: 1.1 }), companyView(), series, T0);
    expect(d).toMatchObject({ ticker: 'OOH', name: 'Obsidian Octopus Holdings', price: 121 });
    expect(d?.navChg1h).toBeCloseTo(0.1);
    expect(d?.priceChg1h).toBeCloseTo(0.21);
    expect(d?.hype).toBeCloseTo(0.1);
  });

  it('treats non-finite numbers as unknown', () => {
    const d = toDisplay(entry({ nav: Number.NaN, hp: Number.NaN }), null, undefined, T0);
    expect(d?.nav).toBeNull();
    expect(d?.hp).toBeNull();
    expect(d?.priceChg1h).toBeNull();
  });
});

describe('filings', () => {
  it('builds sentences from the filing fields only', () => {
    expect(filingText(filing())).toBe('Opened LONG HYPE, $3.4M.');
    expect(
      filingText(filing({ kind: 'CLOSE', sizeBefore: -5, sizeAfter: 0, realizedPnlUsd: 186_000 })),
    ).toBe('Closed the HYPE short for +$186k.');
    expect(
      filingText(filing({ kind: 'REDUCE', sizeBefore: 10, sizeAfter: 8, realizedPnlUsd: null })),
    ).toBe('Cut the HYPE long by 20%.');
    expect(filingText(filing({ kind: 'MARGIN_CALL', detail: null }))).toBe(
      'Margin call: under 10% from liquidation.',
    );
  });

  it('labels a losing close as a loss', () => {
    expect(kindOf({ kind: 'CLOSE', realizedPnlUsd: -1 }).label).toBe('Closed at a loss');
    expect(kindOf({ kind: 'CLOSE', realizedPnlUsd: 1 }).label).toBe('Closed for a profit');
  });

  it('folds repeated margin calls from one company into the newest', () => {
    const items = foldRepeats([
      filing({ id: 4, kind: 'MARGIN_CALL', at: T0 + 3 * 60_000 }),
      filing({ id: 3, kind: 'OPEN', at: T0 + 2 * 60_000 }),
      filing({ id: 2, kind: 'MARGIN_CALL', at: T0 + 60_000 }),
      filing({ id: 1, kind: 'MARGIN_CALL', at: T0 - 60 * 60_000 }),
    ]);
    expect(items.map((i) => [i.filing.id, i.count])).toEqual([
      [4, 2],
      [3, 1],
      [1, 1],
    ]);
  });
});

describe('portfolio arithmetic', () => {
  const long: HoldingView = {
    companyId: 'a',
    ticker: 'OOH',
    longQty: 10,
    longCost: 1_000,
    shortQty: 0,
    shortCollateral: 0,
    price: 120,
    value: 1_200,
  };
  const short: HoldingView = {
    companyId: 'b',
    ticker: 'GBC',
    longQty: 0,
    longCost: 0,
    shortQty: 10,
    shortCollateral: 2_000,
    price: 80,
    value: 1_200,
  };

  it('longs', () => {
    expect(isShort(long)).toBe(false);
    expect(avgEntry(long)).toBe(100);
    expect(holdingPnl(long)).toBe(200);
    expect(holdingReturn(long)).toBeCloseTo(0.2);
  });

  it('shorts: sold at 100 with 2x collateral, now 80', () => {
    expect(isShort(short)).toBe(true);
    expect(avgEntry(short)).toBe(100);
    expect(invested(short)).toBe(1_000);
    expect(holdingPnl(short)).toBe(200);
  });

  it('no price, no profit figure', () => {
    expect(holdingPnl({ ...long, price: null })).toBeNull();
    expect(holdingReturn({ ...long, price: null })).toBeNull();
  });
});

describe('error wording', () => {
  it('maps known codes and keeps the engine message for unknown ones', () => {
    expect(orderErrorText('INSUFFICIENT_CASH', 'x')).toBe('Not enough cash.');
    expect(orderErrorText('SOMETHING_NEW', 'engine says so')).toBe('engine says so');
    expect(ipoErrorText('RATE_LIMITED', 'x')).toMatch(/3 applications an hour/);
  });
});

describe('open IPOs', () => {
  it('counts them with the same rule as the floor, live status first', () => {
    const views = {
      OOH: companyView({ ticker: 'OOH', ipoUntil: T0 + 30_000 }),
      HLT: companyView({ ticker: 'HLT', ipoUntil: T0 + 30_000 }),
      OLD: companyView({ ticker: 'OLD', ipoUntil: T0 - 1 }),
    };
    // The live feed says HLT halted after its REST view was read: the floor shows it halted.
    const byTicker = { HLT: entry({ ticker: 'HLT', status: 'HALTED' }) };
    expect(toDisplay(byTicker.HLT, views.HLT, undefined, T0)?.display).toBe('halted');
    expect(openIpoCount(views, byTicker, T0)).toBe(1);
    expect(openIpoCount(views, {}, T0)).toBe(2);
    expect(openIpoCount(views, byTicker, null)).toBe(0);
  });
});
