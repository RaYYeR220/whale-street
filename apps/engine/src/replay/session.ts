import type { HlRecord } from '@whale-street/hl';
import type { NansenRecord } from '@whale-street/nansen';
import type { MoodSkew } from '../ingest/mood';

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

/**
 * Street mood for one coin as the engine derived and served it: the smart and whale skews only
 * (never the raw Nansen position-intelligence body or its USD totals, which are not
 * redistributable). A skew is null when it was unknown.
 */
export interface MoodRecord extends MoodSkew {
  t: number;
  k: 'mood';
  coin: string;
}

/** One NDJSON line of a session file. */
export type SessionLine = NansenRecord | HlRecord | SeedRecord | MoodRecord;

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

/**
 * Nansen label / entity-name fields (`address_label`, `counterparty_address_label`,
 * `first_funder_name`, …): not redistributable, and the engine never computes anything from them.
 */
const LABEL_KEY = /_(label|name)s?$/i;

/** Deep copy of a response body without any `*_label` / `*_name` key (at any depth). */
export function scrubLabels(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrubLabels);
  if (v === null || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!LABEL_KEY.test(k)) out[k] = scrubLabels(x);
  }
  return out;
}

/**
 * The redistribution policy for one record, shared by the session recorder, the bundler and the
 * REPLAY loader: seed lines, HL feed records and derived street-mood lines pass; Nansen / HL-info
 * records only on an allowlisted path, with label/name fields scrubbed from the body. `null` =
 * must never be recorded, bundled or served.
 */
export function redistributable(r: SessionLine): SessionLine | null {
  if (r.k !== 'nansen') return r;
  if (!REPLAY_ALLOWED_PATHS.has(r.path)) return null;
  return { ...r, body: scrubLabels(r.body) };
}
