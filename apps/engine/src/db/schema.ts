import type {
  CompanyStatus,
  FilingKind,
  ListingVerdict,
  Prospectus,
  Rating,
} from '@whale-street/core';
import type { Eip712Payload } from '@whale-street/nansen';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  CompanySource,
  HaltKind,
  IpoStatus,
  MirrorKind,
  MirrorReason,
  MirrorStatus,
  NavPersist,
  PlayerKind,
  SeasonStatus,
  TradeSide,
} from '../types';

// Drizzle mirrors of the tables created by sql.ts (types + query building only; no drizzle-kit).

export const companies = sqliteTable('companies', {
  id: text('id').primaryKey(),
  ticker: text('ticker').notNull(),
  name: text('name').notNull(),
  logoSeed: integer('logo_seed').notNull(),
  status: text('status').$type<CompanyStatus>().notNull(),
  haltKind: text('halt_kind').$type<HaltKind>(),
  haltReason: text('halt_reason'),
  rating: text('rating').$type<Rating>(),
  source: text('source').$type<CompanySource>().notNull(),
  listedAt: integer('listed_at').notNull(),
  anchorDate: text('anchor_date').notNull(),
  navState: text('nav_state_json', { mode: 'json' }).$type<NavPersist>().notNull(),
  poolX: real('pool_x').notNull(),
  poolY: real('pool_y').notNull(),
  poolL0: real('pool_l0').notNull(),
  hp: real('hp').notNull(),
  ipoUntil: integer('ipo_until').notNull(),
  prospectus: text('prospectus_json', { mode: 'json' }).$type<Prospectus>(),
  delistedAt: integer('delisted_at'),
  cooldownUntil: integer('cooldown_until'),
});

export const navPoints = sqliteTable('nav_points', {
  companyId: text('company_id').notNull(),
  t: integer('t').notNull(),
  nav: real('nav').notNull(),
  price: real('price').notNull(),
});

export const filings = sqliteTable('filings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  companyId: text('company_id').notNull(),
  kind: text('kind').$type<FilingKind>().notNull(),
  coin: text('coin'),
  sizeBefore: real('size_before'),
  sizeAfter: real('size_after'),
  notionalUsd: real('notional_usd'),
  realizedPnlUsd: real('realized_pnl_usd'),
  at: integer('at').notNull(),
  provenance: text('provenance_json', { mode: 'json' }).$type<string[]>().notNull(),
  detail: text('detail'),
});

export const players = sqliteTable('players', {
  id: text('id').primaryKey(),
  handle: text('handle').notNull(),
  tokenHash: text('token_hash').notNull(),
  kind: text('kind').$type<PlayerKind>().notNull(),
  walletAddress: text('wallet_address'),
  createdAt: integer('created_at').notNull(),
});

export const portfolios = sqliteTable('portfolios', {
  playerId: text('player_id').notNull(),
  seasonId: integer('season_id').notNull(),
  cash: real('cash').notNull(),
});

export const holdings = sqliteTable('holdings', {
  playerId: text('player_id').notNull(),
  seasonId: integer('season_id').notNull(),
  companyId: text('company_id').notNull(),
  longQty: real('long_qty').notNull(),
  longCost: real('long_cost').notNull(),
  shortQty: real('short_qty').notNull(),
  shortCollateral: real('short_collateral').notNull(),
});

export const trades = sqliteTable('trades', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  playerId: text('player_id').notNull(),
  seasonId: integer('season_id').notNull(),
  companyId: text('company_id').notNull(),
  side: text('side').$type<TradeSide>().notNull(),
  qty: real('qty').notNull(),
  cash: real('cash').notNull(),
  avgPrice: real('avg_price').notNull(),
  nav: real('nav').notNull(),
  multBefore: real('mult_before').notNull(),
  multAfter: real('mult_after').notNull(),
  forced: integer('forced', { mode: 'boolean' }).notNull(),
  at: integer('at').notNull(),
});

export const ipoSpend = sqliteTable('ipo_spend', {
  playerId: text('player_id').notNull(),
  companyId: text('company_id').notNull(),
  listedAt: integer('listed_at').notNull(),
  spent: real('spent').notNull(),
});

export const seasons = sqliteTable('seasons', {
  id: integer('id').primaryKey(),
  startedAt: integer('started_at').notNull(),
  endsAt: integer('ends_at').notNull(),
  status: text('status').$type<SeasonStatus>().notNull(),
});

export const seasonResults = sqliteTable('season_results', {
  seasonId: integer('season_id').notNull(),
  playerId: text('player_id').notNull(),
  netWorth: real('net_worth').notNull(),
  rank: integer('rank').notNull(),
});

export const ipoApps = sqliteTable('ipo_apps', {
  id: text('id').primaryKey(),
  address: text('address').notNull(),
  playerId: text('player_id'),
  status: text('status').$type<IpoStatus>().notNull(),
  verdict: text('verdict_json', { mode: 'json' }).$type<ListingVerdict>(),
  reason: text('reason'),
  ticker: text('ticker'),
  createdAt: integer('created_at').notNull(),
  decidedAt: integer('decided_at'),
  /** Wall-clock time of the application (the per-hour cap window; never the looping REPLAY clock). */
  appliedWallAt: integer('applied_wall_at'),
});

export const nansenCalls = sqliteTable('nansen_calls', {
  id: text('id').primaryKey(),
  method: text('method').$type<'GET' | 'POST'>().notNull(),
  path: text('path').notNull(),
  requestHash: text('request_hash').notNull(),
  status: integer('status'),
  credits: real('credits'),
  latencyMs: integer('latency_ms').notNull(),
  at: integer('at').notNull(),
  responseHash: text('response_hash'),
  error: text('error'),
  attempts: integer('attempts').notNull(),
});

export const mirrorOrders = sqliteTable('mirror_orders', {
  id: text('id').primaryKey(),
  playerId: text('player_id').notNull(),
  companyId: text('company_id').notNull(),
  coin: text('coin').notNull(),
  kind: text('kind').$type<MirrorKind>().notNull(),
  stepIndex: integer('step_index').notNull(),
  groupId: text('group_id').notNull(),
  status: text('status').$type<MirrorStatus>().notNull(),
  notionalUsd: real('notional_usd').notNull(),
  refusals: text('refusals_json', { mode: 'json' }).$type<MirrorReason[]>(),
  request: text('request_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  action: text('action_json', { mode: 'json' }).$type<Record<string, unknown>>(),
  eip712: text('eip712_json', { mode: 'json' }).$type<Eip712Payload>(),
  nonce: integer('nonce'),
  vaultAddress: text('vault_address'),
  hlOid: integer('hl_oid'),
  avgPx: real('avg_px'),
  error: text('error'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  /** The Hyperliquid master wallet the attempt was made for; caps are counted per wallet. */
  masterAddress: text('master_address'),
});

export const agentKeys = sqliteTable('agent_keys', {
  playerId: text('player_id').primaryKey(),
  masterAddress: text('master_address').notNull(),
  agentAddress: text('agent_address').notNull(),
  registeredAt: integer('registered_at').notNull(),
});

export const kv = sqliteTable('kv', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
