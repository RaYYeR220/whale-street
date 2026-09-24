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
    // A pre-upgrade table: the columns the old schema had, but no master_address column.
    sqlite.exec(
      'CREATE TABLE mirror_orders (id TEXT PRIMARY KEY, player_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0)',
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

  it('adds trades.write_off_usd (0 for older rows) to an existing database (idempotent)', () => {
    const sqlite = new Database(':memory:');
    // The trades table as it was before write-offs were stored.
    sqlite.exec(`CREATE TABLE trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL, season_id INTEGER NOT NULL,
      company_id TEXT NOT NULL, side TEXT NOT NULL, qty REAL NOT NULL, cash REAL NOT NULL,
      avg_price REAL NOT NULL, nav REAL NOT NULL, mult_before REAL NOT NULL,
      mult_after REAL NOT NULL, forced INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL)`);
    sqlite
      .prepare(
        "INSERT INTO trades (player_id, season_id, company_id, side, qty, cash, avg_price, nav, mult_before, mult_after, forced, at) VALUES ('p1', 1, 'c1', 'COVER', 1, 1, 1, 1, 1, 1, 1, 1)",
      )
      .run();
    migrate(sqlite);
    migrate(sqlite);
    expect(sqlite.prepare('SELECT write_off_usd FROM trades').get()).toEqual({ write_off_usd: 0 });
    sqlite.close();
  });

  it('adds nansen_calls.recorded (false for older rows) to an existing database (idempotent)', () => {
    const sqlite = new Database(':memory:');
    // The provenance log as it was before replayed calls were marked.
    sqlite.exec(`CREATE TABLE nansen_calls (
      id TEXT PRIMARY KEY, method TEXT NOT NULL, path TEXT NOT NULL, request_hash TEXT NOT NULL,
      status INTEGER, credits REAL, latency_ms INTEGER NOT NULL, at INTEGER NOT NULL,
      response_hash TEXT, error TEXT, attempts INTEGER NOT NULL)`);
    sqlite
      .prepare(
        "INSERT INTO nansen_calls (id, method, path, request_hash, latency_ms, at, attempts) VALUES ('nc_1', 'POST', '/x', 'h', 1, 1, 1)",
      )
      .run();
    migrate(sqlite);
    migrate(sqlite);
    expect(sqlite.prepare('SELECT recorded FROM nansen_calls').get()).toEqual({ recorded: 0 });
    sqlite.close();
  });

  it('indexes the per-season and per-wallet lookups', () => {
    const { sqlite, close } = openDb(':memory:');
    const indexes = (
      sqlite
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")
        .all() as Array<{
        name: string;
        sql: string;
      }>
    ).map((i) => i.sql.replace(/\s+/g, ' '));
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.stringContaining('ON holdings (season_id, company_id)'),
        expect.stringContaining('ON portfolios (season_id)'),
        expect.stringContaining('ON mirror_orders (master_address, created_at)'),
      ]),
    );
    const plan = (q: string) =>
      (sqlite.prepare(`EXPLAIN QUERY PLAN ${q}`).all() as Array<{ detail: string }>)
        .map((r) => r.detail)
        .join('; ');
    expect(plan('SELECT * FROM holdings WHERE season_id = 1')).toContain('USING INDEX');
    expect(plan('SELECT * FROM portfolios WHERE season_id = 1')).toContain('USING INDEX');
    expect(
      plan("SELECT * FROM mirror_orders WHERE master_address = '0x1' AND created_at >= 0"),
    ).toContain('USING INDEX');
    close();
  });
});
