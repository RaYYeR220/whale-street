import { companyIdentity, multiplier } from '@whale-street/core';
import { describe, expect, it } from 'vitest';
import type { PositionsResult } from '../src/ingest/positions';
import { createBankruptcyService } from '../src/services/bankruptcy';
import { createListingService, pickTicker } from '../src/services/listing';
import { FakeNansen, fail } from './helpers/fake-nansen';
import { addCompany, makeWorld, pos } from './helpers/world';

const A = '0x00000000000000000000000000000000000000a1' as const;

const positions = (over: Partial<PositionsResult> = {}): PositionsResult => ({
  positions: [pos('BTC', 1, 60_000, 50_000)],
  accountValue: 100_000,
  provenance: ['nc_pos'],
  source: 'nansen',
  ...over,
});

function setup() {
  const w = makeWorld();
  const nansen = new FakeNansen();
  const listing = createListingService({ ...w, nansen });
  return { w, nansen, listing };
}

describe('listing service', () => {
  it('lists an ACTIVE company at NAV 100, multiplier 1, with an IPO window and filing', async () => {
    const { w, nansen, listing } = setup();
    nansen.pnl.set(A, {
      realizedPnlUsd: 1_200,
      feesUsd: 200,
      winRate: 0.6,
      closedTrades: 3,
      tradedTimes: 5,
      topCoins: [],
    });
    w.state.setMarks({ BTC: 60_000 }, w.clock.now());
    const rt = await listing.list({
      address: A,
      source: 'IPO_DESK',
      rating: 'AA',
      prospectus: null,
      positions: positions(),
    });
    const identity = companyIdentity(A);
    expect(rt.ticker).toBe(identity.tickerCandidates[0]);
    expect(rt.name).toBe(identity.name);
    expect(rt.status).toBe('ACTIVE');
    expect(rt.nav.nav).toBe(100);
    expect(multiplier(rt.pool)).toBe(1);
    expect(rt.ipoUntil).toBe(w.clock.now() + 60_000);
    expect(rt.summaryBaseline).toBe(1_000);
    expect(rt.anchorDate).toBe('2026-09-21');
    expect(w.state.get(A)).toBe(rt);
    const filing = w.repos.filings.recent(1)[0];
    expect(filing?.kind).toBe('IPO');
    expect(filing?.provenance).toEqual(['nc_pos', 'nc_fake_1']);
    expect(w.repos.companies.get(A)?.ticker).toBe(rt.ticker);
  });

  it('still lists when the pnl summary fails (baseline set later by a heartbeat)', async () => {
    const { nansen, listing } = setup();
    nansen.pnl.set(A, fail('timeout'));
    const rt = await listing.list({
      address: A,
      source: 'SCOUT',
      rating: 'A',
      prospectus: null,
      positions: positions(),
    });
    expect(rt.summaryBaseline).toBeNull();
  });

  it('refuses a duplicate listing and reuses the ticker on relisting after delisting', async () => {
    const { w, listing } = setup();
    const rt = await listing.list({
      address: A,
      source: 'SCOUT',
      rating: 'A',
      prospectus: null,
      positions: positions(),
    });
    await expect(
      listing.list({
        address: A,
        source: 'SCOUT',
        rating: 'A',
        prospectus: null,
        positions: positions(),
      }),
    ).rejects.toThrow('already listed');
    rt.status = 'DELISTED';
    w.statusOps.persist(rt);
    const again = await listing.list({
      address: A,
      source: 'IPO_DESK',
      rating: 'B',
      prospectus: null,
      positions: positions(),
    });
    expect(again.ticker).toBe(rt.ticker);
    expect(again.status).toBe('ACTIVE');
  });

  it('pickTicker skips taken tickers and falls back to X###', () => {
    const c = companyIdentity(A).tickerCandidates;
    expect(pickTicker(A, new Set([c[0] ?? '']))).toBe(c[1]);
    expect(pickTicker(A, new Set(c))).toMatch(/^X[A-Z0-9]{3}$/);
  });
});

describe('bankruptcy service', () => {
  it('settles longs and shorts at NAV, delists with a 14-day cooldown and notifies holders', () => {
    const w = makeWorld();
    const bankruptcy = createBankruptcyService(w);
    const rt = addCompany(w, { id: A, ticker: 'AAA' });
    rt.nav = { ...rt.nav, nav: 20 };
    rt.pool = { x: 4_000, y: 6_000, l0: 5_000 };
    w.repos.seasons.insert({
      id: 1,
      startedAt: 0,
      endsAt: Number.MAX_SAFE_INTEGER,
      status: 'ACTIVE',
    });
    w.repos.portfolios.upsert({ playerId: 'long', seasonId: 1, cash: 100 });
    w.repos.portfolios.upsert({ playerId: 'short', seasonId: 1, cash: 100 });
    w.repos.holdings.upsert({
      playerId: 'long',
      seasonId: 1,
      companyId: A,
      longQty: 10,
      longCost: 1_000,
      shortQty: 0,
      shortCollateral: 0,
    });
    w.repos.holdings.upsert({
      playerId: 'short',
      seasonId: 1,
      companyId: A,
      longQty: 0,
      longCost: 0,
      shortQty: 10,
      shortCollateral: 2_000,
    });

    bankruptcy.declare(rt, w.clock.now());

    expect(rt.status).toBe('DELISTED');
    expect(multiplier(rt.pool)).toBe(1);
    expect(rt.cooldownUntil).toBe(w.clock.now() + 14 * 86_400_000);
    expect(w.repos.portfolios.get('long', 1)?.cash).toBeCloseTo(100 + 10 * 20, 8);
    expect(w.repos.portfolios.get('short', 1)?.cash).toBeCloseTo(100 + 2_000 - 10 * 20, 8);
    expect(w.repos.holdings.forCompany(1, A)).toEqual([]);
    expect(w.repos.trades.recent(5).every((t) => t.side === 'SETTLE' && t.forced)).toBe(true);
    expect(w.repos.companies.get(A)?.status).toBe('DELISTED');
    expect(w.repos.filings.recent(1)[0]?.kind).toBe('DELISTING');
    const notified = w.events.flatMap((e) => (e.t === 'player' ? [e.playerId] : []));
    expect(notified.sort()).toEqual(['long', 'short']);
    bankruptcy.declare(rt, w.clock.now());
    expect(w.repos.filings.recent(10).filter((f) => f.kind === 'DELISTING')).toHaveLength(1);
  });
});
