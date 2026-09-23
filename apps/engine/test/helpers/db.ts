import type { Address, Snapshot } from '@whale-street/core';
import { openDb } from '../../src/db/index';
import { type CompanyRow, createRepos, type Repos } from '../../src/db/repos';
import { T0 } from './fake-clock';

export function testRepos(): Repos {
  return createRepos(openDb(':memory:'));
}

export function snapshotOf(address: Address, over: Partial<Snapshot> = {}): Snapshot {
  return {
    address,
    positions: [],
    accountValue: 50_000,
    realizedSinceAnchor: 0,
    fetchedAt: T0,
    provenance: [],
    ...over,
  };
}

export function companyRow(over: Partial<CompanyRow> & { id: Address }): CompanyRow {
  const snap = snapshotOf(over.id);
  return {
    ticker: 'TST',
    name: 'Test Trader Holdings',
    logoSeed: 1,
    status: 'ACTIVE',
    haltKind: null,
    haltReason: null,
    rating: 'A',
    source: 'SCOUT',
    listedAt: T0,
    anchorDate: '2026-09-21',
    navState: {
      state: { nav: 100, cumPnl: 0, equity: 50_000, snapshot: snap, uSnap: 0 },
      summaryBaseline: null,
      firstSnapshot: snap,
    },
    poolX: 5_000,
    poolY: 5_000,
    poolL0: 5_000,
    hp: 1,
    ipoUntil: T0 + 60_000,
    prospectus: null,
    delistedAt: null,
    cooldownUntil: null,
    ...over,
  };
}
