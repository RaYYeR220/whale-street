import type { HlRecord } from '@whale-street/hl';
import type { NansenRecord } from '@whale-street/nansen';

/** A company that was listed while the session was recorded. */
export interface SeedCompany {
  address: string;
  ticker: string;
  name: string;
  anchorDate: string;
  listedAt: number;
}

export interface SeedRecord {
  t: number;
  k: 'seed';
  company: SeedCompany;
}

/** One NDJSON line of a session file. */
export type SessionLine = NansenRecord | HlRecord | SeedRecord;

/**
 * Endpoints a bundled REPLAY session may contain (redistribution-safe: profiler data and public
 * Hyperliquid info only — never leaderboard, smart-money, labels or trading calls).
 */
export const REPLAY_ALLOWED_PATHS: ReadonlySet<string> = new Set([
  '/api/v1/profiler/perp-positions',
  '/api/v1/profiler/perp-pnl-summary',
  '/api/v1/profiler/perp-trades',
  '/api/v1/profiler/address/related-wallets',
  '/api/v1/profiler/address/first-funder',
  '/api/v1/profiler/address/counterparties',
  '/info',
]);
