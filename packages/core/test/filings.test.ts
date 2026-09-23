import { describe, expect, it } from 'vitest';
import { diffSnapshots, type Position, type Snapshot } from '../src/index';

const ADDR = '0x00000000000000000000000000000000000000bb' as const;
const P = (coin: string, size: number, entryPx: number, liqPx: number | null = null): Position => ({
  coin,
  size,
  entryPx,
  liqPx,
  leverage: 5,
  marginUsed: 0,
  unrealizedPnl: 0,
});
const S = (positions: Position[], accountValue = 10_000, fetchedAt = 1): Snapshot => ({
  address: ADDR,
  positions,
  accountValue,
  realizedSinceAnchor: 0,
  fetchedAt,
  provenance: ['call-1'],
});

describe('diffSnapshots', () => {
  it('OPEN with notional', () => {
    const r = diffSnapshots(S([]), S([P('BTC', 2, 100)]), { BTC: 101 });
    expect(r.filings).toHaveLength(1);
    expect(r.filings[0]).toMatchObject({
      kind: 'OPEN',
      coin: 'BTC',
      sizeBefore: 0,
      sizeAfter: 2,
      notionalUsd: 202,
    });
    expect(r.filings[0]?.provenance).toEqual(['call-1']);
  });

  it('ADD and REDUCE with realized PnL on the reduced amount', () => {
    expect(
      diffSnapshots(S([P('BTC', 1, 100)]), S([P('BTC', 3, 100)]), { BTC: 100 }).filings[0]?.kind,
    ).toBe('ADD');
    const r = diffSnapshots(S([P('BTC', 10, 100)]), S([P('BTC', 4, 100)]), { BTC: 110 });
    expect(r.filings[0]).toMatchObject({ kind: 'REDUCE', realizedPnlUsd: 60 });
  });

  it('CLOSE for a short realizes profit when price fell', () => {
    const r = diffSnapshots(S([P('ETH', -5, 100)]), S([]), { ETH: 90 });
    expect(r.filings[0]).toMatchObject({ kind: 'CLOSE', realizedPnlUsd: 50 });
  });

  it('FLIP realizes the whole previous side', () => {
    const r = diffSnapshots(S([P('SOL', 2, 100)]), S([P('SOL', -1, 120)]), { SOL: 120 });
    expect(r.filings[0]).toMatchObject({ kind: 'FLIP', realizedPnlUsd: 40 });
  });

  it('LIQUIDATION when the mark crossed the previous liq price; BANKRUPTCY if equity collapsed', () => {
    const prev = S([P('BTC', 1, 100, 90)], 10_000);
    const partial = diffSnapshots(prev, S([], 5_000), { BTC: 89 });
    expect(partial.filings.map((f) => f.kind)).toEqual(['LIQUIDATION']);
    expect(partial.liquidated).toBe(true);
    expect(partial.bankrupt).toBe(false);

    const wiped = diffSnapshots(prev, S([], 1_000), { BTC: 89 });
    expect(wiped.filings.map((f) => f.kind)).toEqual(['LIQUIDATION', 'BANKRUPTCY']);
    expect(wiped.bankrupt).toBe(true);
  });

  it('no filings when nothing changed; coins in alphabetical order', () => {
    expect(diffSnapshots(S([P('BTC', 1, 100)]), S([P('BTC', 1, 100)]), { BTC: 1 }).filings).toEqual(
      [],
    );
    const r = diffSnapshots(S([]), S([P('SOL', 1, 1), P('ARB', 1, 1)]), { SOL: 1, ARB: 1 });
    expect(r.filings.map((f) => f.coin)).toEqual(['ARB', 'SOL']);
  });
});
