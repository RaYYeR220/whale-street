import { describe, expect, it } from 'vitest';
import { companyRow, testRepos } from './helpers/db';
import { T0 } from './helpers/fake-clock';

const A = '0x00000000000000000000000000000000000000a1' as const;
const B = '0x00000000000000000000000000000000000000b2' as const;

describe('repos', () => {
  it('companies: upsert, lookups, tickers', () => {
    const r = testRepos();
    r.companies.upsert(companyRow({ id: A, ticker: 'AAA' }));
    r.companies.upsert(companyRow({ id: B, ticker: 'BBB' }));
    r.companies.upsert(
      companyRow({ id: A, ticker: 'AAA', status: 'HALTED', haltKind: 'data', haltReason: 'stale' }),
    );
    expect(r.companies.get(A)?.status).toBe('HALTED');
    expect(r.companies.byTicker('BBB')?.id).toBe(B);
    expect(r.companies.all()).toHaveLength(2);
    expect(r.companies.tickers()).toEqual(new Set(['AAA', 'BBB']));
  });

  it('nav points: a rewrite of the same minute wins, history is bounded on both ends', () => {
    const r = testRepos();
    r.navPoints.insert({ companyId: A, t: T0, nav: 100, price: 100 });
    // REPLAY writes the same minutes again in every loop: the current loop's value must win.
    r.navPoints.insert({ companyId: A, t: T0, nav: 99, price: 98 });
    r.navPoints.insert({ companyId: A, t: T0 + 60_000, nav: 101, price: 102 });
    expect(r.navPoints.history(A, T0, T0 + 60_000).map((p) => [p.nav, p.price])).toEqual([
      [99, 98],
      [101, 102],
    ]);
    expect(r.navPoints.history(A, T0, T0 + 59_999).map((p) => p.nav)).toEqual([99]);
    expect(r.navPoints.atOrBefore(A, T0 + 59_999)?.nav).toBe(99);
    expect(r.navPoints.atOrBefore(A, T0 - 1)).toBeUndefined();
  });

  it('filings: insert returns the row with id, recent is newest first and filterable', () => {
    const r = testRepos();
    const f1 = r.filings.insert({ companyId: A, kind: 'IPO', at: T0, provenance: ['c1'] });
    r.filings.insert({
      companyId: B,
      kind: 'OPEN',
      coin: 'BTC',
      sizeBefore: 0,
      sizeAfter: 1,
      at: T0 + 1,
      provenance: [],
    });
    expect(f1.id).toBeGreaterThan(0);
    expect(f1.provenance).toEqual(['c1']);
    expect(r.filings.recent(10).map((f) => f.kind)).toEqual(['OPEN', 'IPO']);
    expect(r.filings.recent(10, A).map((f) => f.kind)).toEqual(['IPO']);
  });

  it('portfolios, holdings, trades, ipo spend inside a transaction', () => {
    const r = testRepos();
    r.tx(() => {
      r.portfolios.upsert({ playerId: 'p1', seasonId: 1, cash: 10_000 });
      r.portfolios.upsert({ playerId: 'p1', seasonId: 1, cash: 9_000 });
      r.holdings.upsert({
        playerId: 'p1',
        seasonId: 1,
        companyId: A,
        longQty: 1,
        longCost: 100,
        shortQty: 0,
        shortCollateral: 0,
      });
      r.holdings.upsert({
        playerId: 'p2',
        seasonId: 1,
        companyId: A,
        longQty: 0,
        longCost: 0,
        shortQty: 2,
        shortCollateral: 400,
      });
      r.trades.insert({
        playerId: 'p1',
        seasonId: 1,
        companyId: A,
        side: 'BUY',
        qty: 1,
        cash: 100,
        avgPrice: 100,
        nav: 100,
        multBefore: 1,
        multAfter: 1.01,
        forced: false,
        at: T0,
      });
      r.ipoSpend.add('p1', A, T0, 100);
      r.ipoSpend.add('p1', A, T0, 50);
    });
    expect(r.portfolios.get('p1', 1)?.cash).toBe(9_000);
    expect(r.holdings.forCompany(1, A)).toHaveLength(2);
    expect(r.holdings.shortsFor(1, A).map((h) => h.playerId)).toEqual(['p2']);
    r.holdings.remove('p2', 1, A);
    expect(r.holdings.forSeason(1)).toHaveLength(1);
    expect(r.trades.recent(5)[0]?.forced).toBe(false);
    expect(r.ipoSpend.get('p1', A, T0)).toBe(150);
    expect(r.ipoSpend.get('p1', A, T0 + 1)).toBe(0);
  });

  it('counts IPO applications per player and in total since a wall-clock time', () => {
    const r = testRepos();
    const apply = (id: string, playerId: string | null, appliedWallAt: number | null) =>
      r.ipoApps.insert({
        id,
        address: A,
        playerId,
        status: 'PENDING',
        verdict: null,
        reason: null,
        ticker: null,
        createdAt: T0,
        decidedAt: null,
        appliedWallAt,
      });
    apply('a1', 'p1', T0 - 10);
    apply('a2', 'p1', T0);
    apply('a3', 'p2', T0 + 5);
    apply('a4', 'p1', null);
    expect(r.ipoApps.countByPlayerAppliedSince('p1', T0)).toBe(1);
    expect(r.ipoApps.countByPlayerAppliedSince('p1', T0 - 10)).toBe(2);
    expect(r.ipoApps.countByPlayerAppliedSince('p3', 0)).toBe(0);
    expect(r.ipoApps.countAppliedSince(T0)).toBe(2);
  });

  it('rolls back a failed transaction', () => {
    const r = testRepos();
    expect(() =>
      r.tx(() => {
        r.portfolios.upsert({ playerId: 'p1', seasonId: 1, cash: 1 });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(r.portfolios.get('p1', 1)).toBeUndefined();
  });

  it('seasons, players, kv, nansen calls', () => {
    const r = testRepos();
    r.seasons.insert({ id: 1, startedAt: T0, endsAt: T0 + 1, status: 'ACTIVE' });
    expect(r.seasons.current()?.id).toBe(1);
    r.seasons.close(1);
    expect(r.seasons.current()).toBeUndefined();

    r.players.insert({
      id: 'p1',
      handle: 'Lucky Otter #1',
      tokenHash: 'h1',
      kind: 'human',
      walletAddress: null,
      createdAt: T0,
    });
    r.players.setWallet('p1', '0xabc');
    expect(r.players.byTokenHash('h1')?.walletAddress).toBe('0xabc');
    expect(r.players.many(['p1', 'nope'])).toHaveLength(1);

    r.kv.setJson('credits', { remaining: 5 });
    expect(r.kv.getJson<{ remaining: number }>('credits')).toEqual({ remaining: 5 });
    r.kv.delete('credits');
    expect(r.kv.get('credits')).toBeUndefined();
    // Nothing JSON can encode: the key is removed instead of failing at the database.
    r.kv.setJson('credits', { remaining: 5 });
    r.kv.setJson('credits', undefined);
    expect(r.kv.get('credits')).toBeUndefined();
    expect(() => r.kv.setJson('never-set', undefined)).not.toThrow();

    r.nansenCalls.insert({
      id: 'nc_1',
      method: 'POST',
      path: '/api/v1/x',
      requestHash: 'rh',
      status: 200,
      creditsUsed: 1,
      creditsRemaining: null,
      latencyMs: 12,
      at: T0,
      responseHash: 'sh',
      error: null,
      attempts: 1,
    });
    expect(r.nansenCalls.get('nc_1')).toMatchObject({ credits: 1, status: 200 });
    expect(r.nansenCalls.recent(5)).toHaveLength(1);
  });
});
