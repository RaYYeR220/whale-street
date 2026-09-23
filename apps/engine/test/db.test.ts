import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index';
import { companies, kv } from '../src/db/schema';
import { SCHEMA_SQL } from '../src/db/sql';

const TABLES = [
  'agent_keys',
  'companies',
  'filings',
  'holdings',
  'ipo_apps',
  'ipo_spend',
  'kv',
  'mirror_orders',
  'nansen_calls',
  'nav_points',
  'players',
  'portfolios',
  'season_results',
  'seasons',
  'trades',
];

describe('openDb', () => {
  it('creates every table and is idempotent', () => {
    const { sqlite, close } = openDb(':memory:');
    const names = (
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
    )
      .map((r) => r.name)
      .sort();
    expect(names).toEqual(TABLES);
    expect(() => sqlite.exec(SCHEMA_SQL)).not.toThrow();
    close();
  });

  it('round-trips rows and JSON columns through drizzle', () => {
    const { db, close } = openDb(':memory:');
    db.insert(kv).values({ key: 'a', value: '1' }).run();
    expect(db.select().from(kv).where(eq(kv.key, 'a')).get()).toEqual({ key: 'a', value: '1' });

    const snapshot = {
      address: '0x00000000000000000000000000000000000000aa' as const,
      positions: [],
      accountValue: 5_000,
      realizedSinceAnchor: 0,
      fetchedAt: 1,
      provenance: ['c1'],
    };
    db.insert(companies)
      .values({
        id: snapshot.address,
        ticker: 'OOH',
        name: 'Obsidian Octopus Holdings',
        logoSeed: 7,
        status: 'ACTIVE',
        source: 'SCOUT',
        listedAt: 1,
        anchorDate: '2026-09-21',
        navState: {
          state: { nav: 100, cumPnl: 0, equity: 5_000, snapshot, uSnap: 0 },
          summaryBaseline: null,
          firstSnapshot: snapshot,
        },
        poolX: 5_000,
        poolY: 5_000,
        poolL0: 5_000,
        hp: 1,
        ipoUntil: 60_001,
      })
      .run();
    const row = db.select().from(companies).get();
    expect(row?.navState.state.nav).toBe(100);
    expect(row?.navState.firstSnapshot.provenance).toEqual(['c1']);
    expect(row?.prospectus).toBeNull();
    close();
  });
});
