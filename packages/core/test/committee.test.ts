import { describe, expect, it } from 'vitest';
import {
  avgLeverage,
  type Decision,
  downgrade,
  evaluateListing,
  type ListingEvidence,
  none,
  PARAMS,
  type Position,
  ratingScore,
  scoreToRating,
  some,
} from '../src/index';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const APP = '0x00000000000000000000000000000000000000a1' as const;
const LINK = '0x00000000000000000000000000000000000000b2' as const;
const pos = (coin: string, size: number, entryPx: number, leverage = 3): Position => ({
  coin,
  size,
  entryPx,
  liqPx: null,
  leverage,
  marginUsed: 0,
  unrealizedPnl: 0,
});

function clean(): ListingEvidence {
  return {
    address: APP,
    now: NOW,
    firstTradeAt: some(NOW - 200 * DAY),
    pnl: some({
      realizedPnlUsd: 400_000,
      feesUsd: 20_000,
      winRate: 0.64,
      closedTrades: 100,
      tradedTimes: 900,
      topCoins: ['BTC', 'HYPE'],
    }),
    topTradePnlUsd: some(50_000),
    equityUsd: some(600_000),
    positions: some([pos('BTC', 2, 60_000)]),
    linked: some([{ address: LINK, relation: 'related', positions: some([]) }]),
    isVault: some(false),
    marks: { BTC: 60_000 },
    alreadyListed: false,
    cooldownUntil: null,
  };
}

describe('listing committee', () => {
  it('approves a clean trader with a rating and prospectus', () => {
    const v = evaluateListing(clean());
    expect(v.decision).toBe('APPROVED');
    expect(v.checks.map((c) => c.status)).toEqual(['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS']);
    expect(v.rating).not.toBeNull();
    expect(v.prospectus?.style).toBe('Swing Trader');
    expect(v.prospectus?.favoriteCoins).toEqual(['BTC', 'HYPE']);
  });

  it('NEGATIVE CONTROL: denies a hedged cluster and lists the offsetting links', () => {
    const ev = clean();
    ev.linked = some([
      { address: LINK, relation: 'first_funder', positions: some([pos('BTC', -1.5, 60_000)]) },
    ]);
    const v = evaluateListing(ev);
    expect(v.decision).toBe('DENIED');
    expect(v.checks.find((c) => c.id === 'HIDDEN_HEDGE')?.status).toBe('FAIL');
    expect(v.hedgeLinks).toEqual([
      { address: LINK, coin: 'BTC', side: 'SHORT', notionalUsd: 90_000 },
    ]);
    expect(v.rating).toBeNull();
  });

  it('a same-side linked position is not a hedge', () => {
    const ev = clean();
    ev.linked = some([
      { address: LINK, relation: 'related', positions: some([pos('BTC', 5, 60_000)]) },
    ]);
    expect(evaluateListing(ev).decision).toBe('APPROVED');
  });

  it('defers on every missing piece of evidence (fail-closed)', () => {
    const fields = [
      'firstTradeAt',
      'pnl',
      'topTradePnlUsd',
      'equityUsd',
      'positions',
      'linked',
      'isVault',
    ] as const;
    for (const f of fields) {
      const ev = { ...clean(), [f]: none('timeout') } as ListingEvidence;
      expect(evaluateListing(ev).decision, f).toBe('DEFERRED');
    }
    const ev = clean();
    ev.linked = some([{ address: LINK, relation: 'counterparty', positions: none('502') }]);
    expect(evaluateListing(ev).decision).toBe('DEFERRED');
  });

  it('denies short history, small size, market makers, vaults, duplicates, cooldown', () => {
    expect(evaluateListing({ ...clean(), firstTradeAt: some(NOW - 5 * DAY) }).decision).toBe(
      'DENIED',
    );
    expect(evaluateListing({ ...clean(), firstTradeAt: some(null) }).decision).toBe('DENIED');
    expect(evaluateListing({ ...clean(), equityUsd: some(10_000) }).decision).toBe('DENIED');
    const mm = clean();
    mm.pnl = some({
      realizedPnlUsd: 1,
      feesUsd: 1,
      winRate: 0.5,
      closedTrades: 200_000,
      tradedTimes: 400_000,
      topCoins: [],
    });
    expect(evaluateListing(mm).checks.find((c) => c.id === 'HUMAN_TRADER')?.status).toBe('FAIL');
    expect(evaluateListing(mm).decision).toBe('DENIED');
    expect(evaluateListing({ ...clean(), isVault: some(true) }).decision).toBe('DENIED');
    expect(evaluateListing({ ...clean(), alreadyListed: true }).decision).toBe('DENIED');
    expect(evaluateListing({ ...clean(), cooldownUntil: NOW + DAY }).decision).toBe('DENIED');
  });

  it('flags one-hit wonders and downgrades their rating', () => {
    const base = evaluateListing(clean());
    const v = evaluateListing({ ...clean(), topTradePnlUsd: some(300_000) });
    expect(v.decision).toBe('APPROVED');
    expect(v.checks.find((c) => c.id === 'CONCENTRATION')?.status).toBe('FLAG');
    expect(v.rating).toBe(downgrade(base.rating ?? 'CCC', 2));
  });

  function hedgedFixture(): ListingEvidence {
    const ev = clean();
    ev.linked = some([
      { address: LINK, relation: 'first_funder', positions: some([pos('BTC', -1.5, 60_000)]) },
    ]);
    return ev;
  }

  it.each<{ name: string; mutate: (ev: ListingEvidence) => void; decision: Decision }>([
    {
      name: 'NaN mark',
      mutate: (ev) => {
        ev.marks = { BTC: Number.NaN };
      },
      decision: 'DENIED',
    },
    {
      name: 'zero mark',
      mutate: (ev) => {
        ev.marks = { BTC: 0 };
      },
      decision: 'DENIED',
    },
    {
      name: 'negative mark',
      mutate: (ev) => {
        ev.marks = { BTC: -60_000 };
      },
      decision: 'DENIED',
    },
    {
      name: 'NaN applicant size',
      mutate: (ev) => {
        ev.positions = some([pos('BTC', Number.NaN, 60_000)]);
      },
      decision: 'DEFERRED',
    },
    {
      name: 'NaN linked size',
      mutate: (ev) => {
        ev.linked = some([
          {
            address: LINK,
            relation: 'first_funder',
            positions: some([pos('BTC', Number.NaN, 60_000)]),
          },
        ]);
      },
      decision: 'DEFERRED',
    },
  ])('never approves a hedged cluster when $name is corrupted', ({ mutate, decision }) => {
    const ev = hedgedFixture();
    mutate(ev);
    const v = evaluateListing(ev);
    expect(v.decision).not.toBe('APPROVED');
    expect(v.decision).toBe(decision);
  });

  it('denies a hedged cluster once the wallets that loaded already reach the offset threshold, even if another wallet timed out', () => {
    const ev = clean();
    const LINK2 = '0x00000000000000000000000000000000000000c3' as const;
    ev.linked = some([
      { address: LINK, relation: 'related', positions: none('timeout') },
      { address: LINK2, relation: 'first_funder', positions: some([pos('BTC', -1.5, 60_000)]) },
    ]);
    const v = evaluateListing(ev);
    expect(v.decision).toBe('DENIED');
    expect(v.checks.find((c) => c.id === 'HIDDEN_HEDGE')?.status).toBe('FAIL');
  });

  it('stays UNKNOWN when a linked wallet times out and the loaded wallets do not yet reach the offset threshold', () => {
    const ev = clean();
    const LINK2 = '0x00000000000000000000000000000000000000c4' as const;
    ev.linked = some([
      { address: LINK, relation: 'related', positions: none('timeout') },
      { address: LINK2, relation: 'first_funder', positions: some([pos('BTC', -0.2, 60_000)]) },
    ]);
    const v = evaluateListing(ev);
    expect(v.decision).toBe('DEFERRED');
    expect(v.checks.find((c) => c.id === 'HIDDEN_HEDGE')?.status).toBe('UNKNOWN');
  });

  it('HUMAN_TRADER fails on a market-maker profile even when isVault is unavailable', () => {
    const ev = clean();
    ev.pnl = some({
      realizedPnlUsd: 1,
      feesUsd: 1,
      winRate: 0.5,
      closedTrades: 200_000,
      tradedTimes: 400_000,
      topCoins: [],
    });
    ev.isVault = none('timeout');
    const v = evaluateListing(ev);
    expect(v.checks.find((c) => c.id === 'HUMAN_TRADER')?.status).toBe('FAIL');
    expect(v.decision).toBe('DENIED');
  });

  it('HUMAN_TRADER defers (as before) when isVault is unavailable but the profile looks human', () => {
    const ev = { ...clean(), isVault: none('timeout') };
    const v = evaluateListing(ev);
    expect(v.checks.find((c) => c.id === 'HUMAN_TRADER')?.status).toBe('UNKNOWN');
    expect(v.decision).toBe('DEFERRED');
  });

  it('HUMAN_TRADER fails closed when tradedTimes is non-finite', () => {
    const ev = clean();
    ev.pnl = some({
      realizedPnlUsd: 400_000,
      feesUsd: 20_000,
      winRate: 0.64,
      closedTrades: 100,
      tradedTimes: Number.NaN,
      topCoins: ['BTC', 'HYPE'],
    });
    const v = evaluateListing(ev);
    expect(v.checks.find((c) => c.id === 'HUMAN_TRADER')?.status).toBe('FAIL');
    expect(v.decision).toBe('DENIED');
  });

  it('scoreToRating reads its cutoffs from params (spread override)', () => {
    const lenient = {
      ...PARAMS,
      committee: {
        ...PARAMS.committee,
        ratingThresholds: { ...PARAMS.committee.ratingThresholds, AAA: 10 },
      },
    };
    expect(scoreToRating(11, lenient)).toBe('AAA');
    expect(scoreToRating(11)).not.toBe('AAA');
  });

  it('rating helpers', () => {
    expect(scoreToRating(90)).toBe('AAA');
    expect(scoreToRating(70)).toBe('A');
    expect(scoreToRating(10)).toBe('CCC');
    expect(downgrade('AAA', 2)).toBe('A');
    expect(downgrade('B', 5)).toBe('CCC');
    expect(
      ratingScore({
        winRate: 1,
        historyDays: 365,
        realizedPnlUsd: 1e9,
        avgLeverage: 1,
        equityUsd: 1e7,
      }),
    ).toBeCloseTo(100, 6);
    expect(avgLeverage([], {})).toBe(1);
    expect(
      avgLeverage([pos('A', 1, 100, 10), pos('B', 3, 100, 2)], { A: 100, B: 100 }),
    ).toBeCloseTo(4, 10);
  });
});
