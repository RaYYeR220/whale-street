import {
  type Address,
  createPool,
  initNav,
  type Position,
  type Snapshot,
} from '@whale-street/core';
import type { Clock } from '../../src/clock';
import type { Repos } from '../../src/db/repos';
import { type EngineEvent, EventBus } from '../../src/events';
import { type CompanyRuntime, MarketState } from '../../src/market/state';
import { createStatusOps, type StatusOps } from '../../src/market/status';
import { createFilingService, type FilingService } from '../../src/services/filings';
import { testRepos } from './db';
import { FakeClock } from './fake-clock';

export interface World {
  clock: FakeClock;
  repos: Repos;
  bus: EventBus;
  events: EngineEvent[];
  state: MarketState;
  filings: FilingService;
  statusOps: StatusOps;
}

export function makeWorld(): World {
  const clock = new FakeClock();
  const repos = testRepos();
  const bus = new EventBus();
  const events: EngineEvent[] = [];
  bus.on((e) => events.push(e));
  const state = new MarketState(clock.now());
  const filings = createFilingService(repos, state, bus);
  const statusOps = createStatusOps(repos, filings);
  return { clock, repos, bus, events, state, filings, statusOps };
}

export const pos = (
  coin: string,
  size: number,
  entryPx: number,
  liqPx: number | null = null,
  leverage = 5,
): Position => ({
  coin,
  size,
  entryPx,
  liqPx,
  leverage,
  marginUsed: (Math.abs(size) * entryPx) / leverage,
  unrealizedPnl: 0,
});

/** Adds an ACTIVE company (NAV 100, fresh pool) straight into state + DB, bypassing the listing service. */
export function addCompany(
  w: Pick<World, 'state' | 'statusOps'> & { clock: Clock },
  o: {
    id: Address;
    ticker: string;
    positions?: Position[];
    accountValue?: number;
    provenance?: string[];
  },
): CompanyRuntime {
  const now = w.clock.now();
  const snapshot: Snapshot = {
    address: o.id,
    positions: o.positions ?? [],
    accountValue: o.accountValue ?? 50_000,
    realizedSinceAnchor: 0,
    fetchedAt: now,
    provenance: o.provenance ?? ['nc_seed'],
  };
  const rt: CompanyRuntime = {
    id: o.id,
    ticker: o.ticker,
    name: `${o.ticker} Holdings`,
    logoSeed: 1,
    rating: 'A',
    source: 'SCOUT',
    status: 'ACTIVE',
    haltKind: null,
    haltReason: null,
    listedAt: now,
    anchorDate: '2026-09-21',
    ipoUntil: now + 60_000,
    prospectus: null,
    nav: initNav(snapshot),
    summaryBaseline: null,
    firstSnapshot: snapshot,
    pool: createPool(),
    hp: 1,
    lastSnapshotAt: now,
    pendingTriggerAt: null,
    lastPointMinute: -1,
    delistedAt: null,
    cooldownUntil: null,
  };
  w.state.add(rt);
  w.statusOps.persist(rt);
  return rt;
}
