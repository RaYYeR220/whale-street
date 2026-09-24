import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index';
import { companies, kv } from '../src/db/schema';
import { ensureColumn, migrate, SCHEMA_SQL } from '../src/db/sql';

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

  it('upgrades an existing mirror_orders table with master_address (idempotent)', () => {
    const sqlite = new Database(':memory:');
    // A pre-upgrade table: everything the old schema had, but no master_address column.
    sqlite.exec(
      'CREATE TABLE mirror_orders (id TEXT PRIMARY KEY, player_id TEXT NOT NULL, status TEXT NOT NULL)',
    );
    sqlite
      .prepare("INSERT INTO mirror_orders (id, player_id, status) VALUES ('m1', 'p1', 'FILLED')")
      .run();
    const columns = () =>
      (sqlite.prepare('PRAGMA table_info(mirror_orders)').all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
    expect(columns()).not.toContain('master_address');
    migrate(sqlite);
    migrate(sqlite);
    expect(columns()).toContain('master_address');
    expect(
      sqlite.prepare("SELECT master_address FROM mirror_orders WHERE id = 'm1'").get(),
    ).toEqual({
      master_address: null,
    });
    expect(() => ensureColumn(sqlite, 'mirror_orders', 'master_address', 'TEXT')).not.toThrow();
    sqlite.close();
  });

  it('creates mirror_orders with master_address on a fresh database', () => {
    const { sqlite, close } = openDb(':memory:');
    const cols = (
      sqlite.prepare('PRAGMA table_info(mirror_orders)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain('master_address');
    close();
  });
});
