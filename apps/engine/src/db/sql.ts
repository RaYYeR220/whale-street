import type Database from 'better-sqlite3';

/** Hand-written schema, executed at every boot (idempotent). Money columns are REAL (play-USD). */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  logo_seed INTEGER NOT NULL,
  status TEXT NOT NULL,
  halt_kind TEXT,
  halt_reason TEXT,
  rating TEXT,
  source TEXT NOT NULL,
  listed_at INTEGER NOT NULL,
  anchor_date TEXT NOT NULL,
  nav_state_json TEXT NOT NULL,
  pool_x REAL NOT NULL,
  pool_y REAL NOT NULL,
  pool_l0 REAL NOT NULL,
  hp REAL NOT NULL,
  ipo_until INTEGER NOT NULL,
  prospectus_json TEXT,
  delisted_at INTEGER,
  cooldown_until INTEGER
);
CREATE TABLE IF NOT EXISTS nav_points (
  company_id TEXT NOT NULL,
  t INTEGER NOT NULL,
  nav REAL NOT NULL,
  price REAL NOT NULL,
  PRIMARY KEY (company_id, t)
);
CREATE TABLE IF NOT EXISTS filings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  coin TEXT,
  size_before REAL,
  size_after REAL,
  notional_usd REAL,
  realized_pnl_usd REAL,
  at INTEGER NOT NULL,
  provenance_json TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS filings_company_at ON filings (company_id, at);
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  wallet_address TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS portfolios (
  player_id TEXT NOT NULL,
  season_id INTEGER NOT NULL,
  cash REAL NOT NULL,
  PRIMARY KEY (player_id, season_id)
);
CREATE TABLE IF NOT EXISTS holdings (
  player_id TEXT NOT NULL,
  season_id INTEGER NOT NULL,
  company_id TEXT NOT NULL,
  long_qty REAL NOT NULL,
  long_cost REAL NOT NULL,
  short_qty REAL NOT NULL,
  short_collateral REAL NOT NULL,
  PRIMARY KEY (player_id, season_id, company_id)
);
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  season_id INTEGER NOT NULL,
  company_id TEXT NOT NULL,
  side TEXT NOT NULL,
  qty REAL NOT NULL,
  cash REAL NOT NULL,
  avg_price REAL NOT NULL,
  nav REAL NOT NULL,
  mult_before REAL NOT NULL,
  mult_after REAL NOT NULL,
  forced INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL,
  write_off_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS trades_company_at ON trades (company_id, at);
CREATE TABLE IF NOT EXISTS ipo_spend (
  player_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  listed_at INTEGER NOT NULL,
  spent REAL NOT NULL,
  PRIMARY KEY (player_id, company_id, listed_at)
);
CREATE TABLE IF NOT EXISTS seasons (
  id INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS season_results (
  season_id INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  net_worth REAL NOT NULL,
  rank INTEGER NOT NULL,
  PRIMARY KEY (season_id, player_id)
);
CREATE TABLE IF NOT EXISTS ipo_apps (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  player_id TEXT,
  status TEXT NOT NULL,
  verdict_json TEXT,
  reason TEXT,
  ticker TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  applied_wall_at INTEGER
);
CREATE INDEX IF NOT EXISTS ipo_apps_address ON ipo_apps (address);
CREATE TABLE IF NOT EXISTS nansen_calls (
  id TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER,
  credits REAL,
  latency_ms INTEGER NOT NULL,
  at INTEGER NOT NULL,
  response_hash TEXT,
  error TEXT,
  attempts INTEGER NOT NULL,
  recorded INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS mirror_orders (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  coin TEXT NOT NULL,
  kind TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  group_id TEXT NOT NULL,
  status TEXT NOT NULL,
  notional_usd REAL NOT NULL,
  refusals_json TEXT,
  request_json TEXT NOT NULL,
  action_json TEXT,
  eip712_json TEXT,
  nonce INTEGER,
  vault_address TEXT,
  hl_oid INTEGER,
  avg_px REAL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  master_address TEXT
);
CREATE TABLE IF NOT EXISTS agent_keys (
  player_id TEXT PRIMARY KEY,
  master_address TEXT NOT NULL,
  agent_address TEXT NOT NULL,
  registered_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Adds `column` to `table` (as `ALTER TABLE … ADD COLUMN column ddl`) unless it already exists. */
export function ensureColumn(
  sqlite: Database.Database,
  table: string,
  column: string,
  ddl: string,
): void {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column))
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

/**
 * Indexes created after the columns they cover exist (so an upgraded database gets them too):
 * the per-season leaderboard / rollover reads and the per-wallet Mirror cap reads.
 */
const INDEX_SQL = `
CREATE INDEX IF NOT EXISTS holdings_season ON holdings (season_id, company_id);
CREATE INDEX IF NOT EXISTS portfolios_season ON portfolios (season_id);
CREATE INDEX IF NOT EXISTS mirror_orders_master ON mirror_orders (master_address, created_at);
`;

/** Creates missing tables, then adds columns introduced after a table was first created. */
export function migrate(sqlite: Database.Database): void {
  sqlite.exec(SCHEMA_SQL);
  ensureColumn(sqlite, 'mirror_orders', 'master_address', 'TEXT');
  ensureColumn(sqlite, 'ipo_apps', 'applied_wall_at', 'INTEGER');
  ensureColumn(sqlite, 'trades', 'write_off_usd', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(sqlite, 'nansen_calls', 'recorded', 'INTEGER NOT NULL DEFAULT 0');
  // Rows written before the column existed were LIVE rows, whose created_at is wall time.
  sqlite.exec('UPDATE ipo_apps SET applied_wall_at = created_at WHERE applied_wall_at IS NULL');
  sqlite.exec(INDEX_SQL);
}
