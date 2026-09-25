import type { Position } from '@whale-street/core';
import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/events';
import { createRefresher, restatementThreshold } from '../src/ingest/refresh';
import { silentLogger } from '../src/log';
import { MarketState, runtimeFromRow } from '../src/market/state';
import { createStatusOps } from '../src/market/status';
import { createBankruptcyService } from '../src/services/bankruptcy';
import { createFilingService } from '../src/services/filings';
import { FakeInfo } from './helpers/fake-hl';
import { FakeNansen, fail } from './helpers/fake-nansen';
import { addCompany, makeWorld, pos } from './helpers/world';

const A = '0x00000000000000000000000000000000000000a1' as const;

function setup(initial: Position[] = [], accountValue = 100_000) {
  const w = makeWorld();
  const nansen = new FakeNansen();
  const info = new FakeInfo();
  const bankruptcy = createBankruptcyService(w);
  const refresher = createRefresher({ ...w, nansen, info, bankruptcy, log: silentLogger });
  const rt = addCompany(w, { id: A, ticker: 'AAA', positions: initial, accountValue });
  const serve = (positions: Position[], value = accountValue) =>
    nansen.positions.set(A, { positions, accountValue: value, time: null });
  return { w, nansen, info, refresher, rt, serve };
}

const kinds = (w: ReturnType<typeof makeWorld>) =>
  w.repos.filings
    .recent(50)
    .map((f) => f.kind)
    .reverse();

describe('refresher', () => {
  it('files OPEN, swaps the snapshot and clears a pending trigger', async () => {
    const { w, refresher, rt, serve } = setup();
    serve([pos('ETH', 10, 3_000)]);
    rt.pendingTriggerAt = w.clock.now();
    w.clock.advance(5_000);
    w.state.setMarks({ ETH: 3_000 }, w.clock.now());
    expect(await refresher.refresh(A, 'trigger')).toEqual({ kind: 'ok' });
    expect(kinds(w)).toEqual(['OPEN']);
    expect(rt.nav.snapshot.positions).toHaveLength(1);
    expect(rt.lastSnapshotAt).toBe(w.clock.now());
    expect(rt.pendingTriggerAt).toBeNull();
    expect(w.repos.filings.recent(1)[0]?.provenance).toEqual(['nc_fake_1']);
  });

  it('books provisional realized PnL from a CLOSE and keeps NAV continuous', async () => {
    const { w, refresher, rt, serve } = setup([pos('BTC', 1, 60_000)], 100_000);
    w.state.setMarks({ BTC: 61_000 }, w.clock.now());
    const before = rt.nav;
    serve([], 101_000);
    await refresher.refresh(A, 'trigger');
    expect(kinds(w)).toEqual(['CLOSE']);
    expect(rt.nav.snapshot.realizedSinceAnchor).toBeCloseTo(1_000, 8);
    expect(rt.nav.nav).toBeCloseTo(before.nav * (1 + 1_000 / before.equity), 8);
  });

  it('reconciles against the pnl summary on heartbeats and files a RESTATEMENT on drift', async () => {
    const { w, nansen, refresher, rt, serve } = setup([], 100_000);
    serve([], 100_000);
    rt.summaryBaseline = 5_000;
    nansen.pnl.set(A, {
      realizedPnlUsd: 5_700,
      feesUsd: 100,
      winRate: 0.5,
      closedTrades: 1,
      tradedTimes: 1,
      topCoins: [],
    });
    await refresher.refresh(A, 'heartbeat');
    expect(rt.nav.snapshot.realizedSinceAnchor).toBeCloseTo(600, 8);
    const f = w.repos.filings.recent(1)[0];
    expect(f?.kind).toBe('RESTATEMENT');
    expect(f?.realizedPnlUsd).toBeCloseTo(600, 8);
    expect(f?.detail).toContain('Nansen perp-pnl-summary');

    nansen.pnl.set(A, {
      realizedPnlUsd: 5_710,
      feesUsd: 100,
      winRate: 0.5,
      closedTrades: 1,
      tradedTimes: 1,
      topCoins: [],
    });
    await refresher.refresh(A, 'heartbeat');
    expect(w.repos.filings.recent(10).filter((x) => x.kind === 'RESTATEMENT')).toHaveLength(1);
    expect(restatementThreshold(100_000)).toBe(500);
  });

  it('sets the summary baseline on the first heartbeat when listing could not, and never blocks on summary failure', async () => {
    const { nansen, refresher, rt, serve } = setup();
    serve([]);
    nansen.pnl.set(A, fail('timeout'));
    expect(await refresher.refresh(A, 'heartbeat')).toEqual({ kind: 'ok' });
    expect(rt.summaryBaseline).toBeNull();
    nansen.pnl.set(A, {
      realizedPnlUsd: 900,
      feesUsd: 100,
      winRate: 0.5,
      closedTrades: 1,
      tradedTimes: 1,
      topCoins: [],
    });
    await refresher.refresh(A, 'heartbeat');
    expect(rt.summaryBaseline).toBe(800);
  });

  it('reports failures without touching the snapshot (the loop halts on staleness)', async () => {
    const { w, nansen, refresher, rt } = setup();
    nansen.positions.set(A, fail('HTTP 429: slow down'));
    rt.pendingTriggerAt = w.clock.now();
    const before = rt.nav;
    expect(await refresher.refresh(A, 'trigger')).toEqual({
      kind: 'failed',
      error: 'nansen: HTTP 429: slow down',
    });
    expect(rt.nav).toBe(before);
    expect(rt.pendingTriggerAt).toBe(w.clock.now());
  });

  it('skips heartbeats while idle but serves mirror/listing/wake refreshes', async () => {
    const { w, nansen, refresher, serve } = setup();
    serve([]);
    w.state.flags.idle = true;
    expect(await refresher.refresh(A, 'heartbeat')).toEqual({ kind: 'skipped', why: 'idle' });
    expect(nansen.count('perpPositions')).toBe(0);
    expect(await refresher.refresh(A, 'mirror')).toEqual({ kind: 'ok' });
  });

  it('uses Hyperliquid clearinghouse state in credit-saver mode', async () => {
    const { w, nansen, info, refresher, rt } = setup();
    w.state.flags.creditSaver = true;
    info.states.set(A, { positions: [pos('SOL', 5, 150)], accountValue: 99_000, time: null });
    await refresher.refresh(A, 'heartbeat');
    expect(nansen.count('perpPositions')).toBe(0);
    expect(rt.nav.snapshot.provenance[0]).toBe('hl:clearinghouseState');
    expect(rt.nav.snapshot.positions[0]?.coin).toBe('SOL');
  });

  it('in credit-saver only routine refreshes move to Hyperliquid; mirror refreshes keep Nansen', async () => {
    const { w, nansen, info, refresher, rt, serve } = setup();
    w.state.flags.creditSaver = true;
    serve([pos('ETH', 10, 3_000)]);
    info.states.set(A, { positions: [pos('SOL', 5, 150)], accountValue: 99_000, time: null });
    for (const reason of ['heartbeat', 'trigger', 'wake'] as const) {
      await refresher.refresh(A, reason);
      expect(rt.nav.snapshot.provenance).toEqual(['hl:clearinghouseState']);
    }
    expect(nansen.count('perpPositions')).toBe(0);
    await refresher.refresh(A, 'mirror');
    expect(nansen.count('perpPositions')).toBe(1);
    expect(rt.nav.snapshot.positions.map((p) => p.coin)).toEqual(['ETH']);
    expect(rt.nav.snapshot.provenance[0]).toMatch(/^nc_/);
  });

  it('a mirror refresh never rides on an in-flight Hyperliquid refresh: it runs its own Nansen fetch', async () => {
    const { w, nansen, info, refresher, rt, serve } = setup();
    w.state.flags.creditSaver = true;
    serve([pos('ETH', 10, 3_000)]);
    info.states.set(A, { positions: [pos('SOL', 5, 150)], accountValue: 99_000, time: null });
    const routine = refresher.refresh(A, 'heartbeat');
    const mirror = refresher.refresh(A, 'mirror');
    expect(mirror).not.toBe(routine);
    // Another routine refresh joins the queued Nansen one (Nansen data serves every reason).
    expect(refresher.refresh(A, 'trigger')).toBe(mirror);
    expect(await mirror).toEqual({ kind: 'ok' });
    expect(await routine).toEqual({ kind: 'ok' });
    expect(nansen.count('perpPositions')).toBe(1);
    expect(rt.nav.snapshot.provenance[0]).toMatch(/^nc_/);
    expect(refresher.pending()).toEqual([]);
    // In-flight Nansen refresh: a mirror refresh joins it.
    w.state.flags.creditSaver = false;
    const first = refresher.refresh(A, 'heartbeat');
    expect(refresher.refresh(A, 'mirror')).toBe(first);
    await first;
  });

  it('drops zero-size rows (closed coins) from both sources; a non-finite size still fails the snapshot', async () => {
    const { w, nansen, info, refresher, rt, serve } = setup();
    serve([pos('ETH', 10, 3_000), pos('DOGE', 0, 0.1)]);
    expect(await refresher.refresh(A, 'heartbeat')).toEqual({ kind: 'ok' });
    expect(rt.nav.snapshot.positions.map((p) => p.coin)).toEqual(['ETH']);
    expect(rt.status).toBe('ACTIVE');

    w.state.flags.creditSaver = true;
    info.states.set(A, {
      positions: [pos('SOL', 0, 150), pos('ETH', 10, 3_000)],
      accountValue: 100_000,
      time: null,
    });
    expect(await refresher.refresh(A, 'heartbeat')).toEqual({ kind: 'ok' });
    expect(rt.nav.snapshot.positions.map((p) => p.coin)).toEqual(['ETH']);

    w.state.flags.creditSaver = false;
    serve([pos('ETH', 10, 3_000), { ...pos('DOGE', 1, 0.1), size: Number.NaN }]);
    expect(await refresher.refresh(A, 'heartbeat')).toEqual({
      kind: 'failed',
      error: 'snapshot failed sanity checks',
    });
    expect(nansen.count('perpPositions')).toBe(2);
  });

  it('declares bankruptcy on a liquidation that wipes out equity', async () => {
    const { w, refresher, rt, serve } = setup([pos('ETH', 100, 3_000, 2_800)], 30_000);
    w.repos.seasons.insert({
      id: 1,
      startedAt: 0,
      endsAt: Number.MAX_SAFE_INTEGER,
      status: 'ACTIVE',
    });
    w.repos.portfolios.upsert({ playerId: 'p1', seasonId: 1, cash: 0 });
    w.repos.holdings.upsert({
      playerId: 'p1',
      seasonId: 1,
      companyId: A,
      longQty: 5,
      longCost: 500,
      shortQty: 0,
      shortCollateral: 0,
    });
    w.state.setMarks({ ETH: 2_790 }, w.clock.now());
    serve([], 1_000);
    await refresher.refresh(A, 'trigger');
    expect(kinds(w)).toEqual(['LIQUIDATION', 'BANKRUPTCY', 'DELISTING']);
    expect(rt.status).toBe('DELISTED');
    expect(w.repos.portfolios.get('p1', 1)?.cash).toBeCloseTo(5 * rt.nav.nav, 8);
    expect(await refresher.refresh(A, 'heartbeat')).toEqual({ kind: 'skipped', why: 'not listed' });
  });

  it('halts on low reported equity and resumes when it recovers', async () => {
    const { rt, refresher, serve } = setup([], 50_000);
    serve([], 800);
    await refresher.refresh(A, 'heartbeat');
    expect(rt.status).toBe('HALTED');
    expect(rt.haltKind).toBe('equity');
    serve([], 5_000);
    await refresher.refresh(A, 'heartbeat');
    expect(rt.status).toBe('ACTIVE');
  });

  it('leaves a missing-mark halt to the market loop: a fresh snapshot does not lift it', async () => {
    const { w, refresher, rt, serve } = setup([pos('XYZ', 10, 5)]);
    serve([pos('XYZ', 10, 5)]);
    w.statusOps.halt(rt, 'data', 'no mark for XYZ', w.clock.now());
    expect(await refresher.refresh(A, 'heartbeat')).toEqual({ kind: 'ok' });
    expect(rt.status).toBe('HALTED');
    expect(rt.haltReason).toBe('no mark for XYZ');
  });

  it('retries a bankruptcy whose settlement failed on the next refresh', async () => {
    const { w, refresher, rt, serve } = setup([pos('ETH', 100, 3_000, 2_800)], 30_000);
    w.repos.seasons.insert({
      id: 1,
      startedAt: 0,
      endsAt: Number.MAX_SAFE_INTEGER,
      status: 'ACTIVE',
    });
    w.repos.portfolios.upsert({ playerId: 'p1', seasonId: 1, cash: 0 });
    w.repos.holdings.upsert({
      playerId: 'p1',
      seasonId: 1,
      companyId: A,
      longQty: 5,
      longCost: 500,
      shortQty: 0,
      shortCollateral: 0,
    });
    w.state.setMarks({ ETH: 2_790 }, w.clock.now());
    serve([], 1_000);
    const insert = vi.spyOn(w.repos.trades, 'insert').mockImplementation(() => {
      throw new Error('disk I/O error');
    });
    await refresher.refresh(A, 'trigger');
    // Not tradable while settlement is pending, and that halt is persisted (survives a restart).
    expect(rt.status).toBe('HALTED');
    expect(rt.haltKind).toBe('data');
    expect(rt.haltReason).toBe('settlement pending');
    expect(w.repos.companies.get(A)).toMatchObject({
      status: 'HALTED',
      haltKind: 'data',
      haltReason: 'settlement pending',
    });
    expect(w.repos.holdings.forCompany(1, A)).toHaveLength(1);
    insert.mockRestore();
    await refresher.refresh(A, 'heartbeat');
    expect(rt.status).toBe('DELISTED');
    expect(w.repos.holdings.forCompany(1, A)).toEqual([]);
    expect(w.repos.portfolios.get('p1', 1)?.cash).toBeCloseTo(5 * rt.nav.nav, 8);
    expect(kinds(w).filter((k) => k === 'DELISTING')).toHaveLength(1);
  });

  it('retries a persisted settlement-pending halt after a simulated restart', async () => {
    const { w, nansen, info, refresher, serve } = setup([pos('ETH', 100, 3_000, 2_800)], 30_000);
    w.repos.seasons.insert({
      id: 1,
      startedAt: 0,
      endsAt: Number.MAX_SAFE_INTEGER,
      status: 'ACTIVE',
    });
    w.repos.portfolios.upsert({ playerId: 'p1', seasonId: 1, cash: 0 });
    w.repos.holdings.upsert({
      playerId: 'p1',
      seasonId: 1,
      companyId: A,
      longQty: 5,
      longCost: 500,
      shortQty: 0,
      shortCollateral: 0,
    });
    w.state.setMarks({ ETH: 2_790 }, w.clock.now());
    serve([], 1_000);
    const insert = vi.spyOn(w.repos.trades, 'insert').mockImplementation(() => {
      throw new Error('disk I/O error');
    });
    await refresher.refresh(A, 'trigger');
    insert.mockRestore();
    const persisted = w.repos.companies.get(A);
    expect(persisted).toMatchObject({ status: 'HALTED', haltReason: 'settlement pending' });
    if (!persisted) throw new Error('company row vanished');

    // Simulated restart: brand-new in-memory state and services (empty `unsettled`), loaded only
    // from the persisted row.
    const bus2 = new EventBus();
    const state2 = new MarketState(w.clock.now());
    state2.awaitingNavTick = false;
    const rt2 = runtimeFromRow(persisted);
    state2.add(rt2);
    const filings2 = createFilingService(w.repos, state2, bus2, () => w.clock.now());
    const statusOps2 = createStatusOps(w.repos, filings2);
    const bankruptcy2 = createBankruptcyService({
      repos: w.repos,
      filings: filings2,
      statusOps: statusOps2,
      bus: bus2,
      log: silentLogger,
    });
    const refresher2 = createRefresher({
      state: state2,
      filings: filings2,
      statusOps: statusOps2,
      bankruptcy: bankruptcy2,
      nansen,
      info,
      clock: w.clock,
      log: silentLogger,
    });
    expect(rt2.status).toBe('HALTED');
    expect(await refresher2.refresh(A, 'heartbeat')).toEqual({ kind: 'ok' });
    expect(rt2.status).toBe('DELISTED');
    expect(w.repos.holdings.forCompany(1, A)).toEqual([]);
    expect(w.repos.portfolios.get('p1', 1)?.cash).toBeCloseTo(5 * rt2.nav.nav, 8);
    expect(kinds(w).filter((k) => k === 'DELISTING')).toHaveLength(1);
  });

  it('resumes a data halt on the next good snapshot and dedupes concurrent refreshes', async () => {
    const { w, nansen, refresher, rt, serve } = setup();
    serve([]);
    w.statusOps.halt(rt, 'data', 'no fresh snapshot for 30 min', w.clock.now());
    const p1 = refresher.refresh(A, 'heartbeat');
    const p2 = refresher.refresh(A, 'trigger');
    expect(p2).toBe(p1);
    expect(refresher.pending()).toHaveLength(1);
    await p1;
    expect(nansen.count('perpPositions')).toBe(1);
    expect(rt.status).toBe('ACTIVE');
    expect(kinds(w)).toEqual(['HALT', 'RESUME']);
  });
});
