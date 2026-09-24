import {
  type Address,
  companyIdentity,
  computeHp,
  createPool,
  hash32,
  initNav,
  isSaneSnapshot,
  PARAMS,
  type Params,
  type Prospectus,
  type Rating,
  type Snapshot,
} from '@whale-street/core';
import type { Clock } from '../clock';
import { utcDate } from '../dates';
import type { Repos } from '../db/repos';
import type { PositionsResult } from '../ingest/positions';
import type { CompanyRuntime, MarketState } from '../market/state';
import type { StatusOps } from '../market/status';
import type { NansenPort } from '../ports';
import type { CompanySource } from '../types';
import type { FilingService } from './filings';

export interface ListingInput {
  address: Address;
  source: CompanySource;
  rating: Rating | null;
  prospectus: Prospectus | null;
  /** Positions the listing decision was made on (becomes the first snapshot). */
  positions: PositionsResult;
  /**
   * SEEDED (REPLAY): the recorded company's anchor date, used for its pnl-summary requests. Never
   * recomputed from the looping replay clock. Absent: the listing day.
   */
  anchorDate?: string;
}

export interface ListingDeps {
  state: MarketState;
  repos: Repos;
  filings: FilingService;
  statusOps: StatusOps;
  nansen: NansenPort;
  clock: Clock;
  params?: Params;
}

export interface ListingService {
  list(input: ListingInput): Promise<CompanyRuntime>;
}

/** First unused ticker candidate; falls back to a hash-derived `X###` ticker. */
export function pickTicker(address: Address, taken: ReadonlySet<string>): string {
  for (const t of companyIdentity(address).tickerCandidates) if (!taken.has(t)) return t;
  for (let i = 0; ; i++) {
    const t = `X${(hash32(`${address}:${i}`) % 46_656).toString(36).toUpperCase().padStart(3, '0')}`;
    if (!taken.has(t)) return t;
  }
}

export function createListingService(d: ListingDeps): ListingService {
  const params = d.params ?? PARAMS;
  const inProgress = new Set<string>();

  return {
    async list(input) {
      const address = input.address.toLowerCase() as Address;
      const existing = d.repos.companies.get(address);
      if (existing && existing.status !== 'DELISTED') throw new Error(`already listed: ${address}`);
      if (inProgress.has(address)) throw new Error(`listing in progress: ${address}`);
      inProgress.add(address);
      try {
        const startedAt = d.clock.now();
        const anchorDate = input.anchorDate ?? utcDate(startedAt);
        const summary = await d.nansen.perpPnlSummary(address, anchorDate, anchorDate);
        const now = d.clock.now();
        const provenance = [...input.positions.provenance, ...(summary.ok ? [summary.callId] : [])];
        const snapshot: Snapshot = {
          address,
          positions: input.positions.positions,
          accountValue: input.positions.accountValue,
          realizedSinceAnchor: 0,
          fetchedAt: now,
          provenance,
        };
        if (!isSaneSnapshot(snapshot)) throw new Error(`snapshot failed sanity checks: ${address}`);
        const identity = companyIdentity(address);
        const ticker = existing?.ticker ?? pickTicker(address, d.repos.companies.tickers());
        const rt: CompanyRuntime = {
          id: address,
          ticker,
          name: identity.name,
          logoSeed: identity.logoSeed,
          rating: input.rating,
          source: input.source,
          status: 'ACTIVE',
          haltKind: null,
          haltReason: null,
          listedAt: now,
          anchorDate,
          ipoUntil: now + params.ipoWindowMs,
          prospectus: input.prospectus,
          nav: initNav(snapshot, params.navStart),
          summaryBaseline: summary.ok ? summary.value.realizedPnlUsd - summary.value.feesUsd : null,
          firstSnapshot: snapshot,
          pool: createPool(params.poolDepth),
          hp: computeHp(snapshot.positions, d.state.marks),
          lastSnapshotAt: now,
          pendingTriggerAt: null,
          lastPointMinute: -1,
          delistedAt: null,
          cooldownUntil: null,
        };
        d.state.add(rt);
        d.statusOps.persist(rt);
        d.filings.record(address, {
          kind: 'IPO',
          at: now,
          provenance,
          detail: `${ticker} listed (${input.source === 'IPO_DESK' ? 'IPO desk' : input.source === 'SCOUT' ? 'scout' : 'replay seed'})`,
        });
        return rt;
      } finally {
        inProgress.delete(address);
      }
    },
  };
}
