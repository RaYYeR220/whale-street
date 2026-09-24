import type { CohortPositioning } from '@whale-street/nansen';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import type { Logger } from '../log';
import type { MarketState } from '../market/state';
import type { NansenPort } from '../ports';

export const MOOD_COINS = 6;
/** kv key: engine-clock time of the last street-mood refresh (seeds the schedule at boot). */
export const MOOD_LAST_KEY = 'mood:last';
/** kv key: the last derived street mood per coin, restored at boot. */
export const MOOD_SNAPSHOT_KEY = 'mood:snapshot';

/**
 * Street mood of one coin as the engine serves it: how two Nansen cohorts lean, derived from their
 * position-intelligence totals. Only these skews leave the engine, never the raw USD totals.
 */
export interface MoodSkew {
  /** Smart traders: (long − short) / (long + short) ∈ [−1, 1]; null when unknown. */
  smartSkew: number | null;
  /** Whales, same definition. */
  whaleSkew: number | null;
}

/** A coin's mood and when its cohort data was fetched (engine clock; REPLAY: recording time). */
export interface StreetMood extends MoodSkew {
  asOf: number;
}

/**
 * (long − short) / (long + short) ∈ [−1, 1]. Null when either side is unknown or nothing is
 * positioned (sum 0): an unknown side is never taken as zero. The totals are magnitudes, so a
 * short total reported as a negative figure counts by its size.
 */
export function skew(long: number | null, short: number | null): number | null {
  if (long === null || short === null) return null;
  const l = Math.abs(long);
  const s = Math.abs(short);
  const sum = l + s;
  if (!(Number.isFinite(sum) && sum > 0)) return null;
  return (l - s) / sum;
}

export function skewsOf(p: CohortPositioning): MoodSkew {
  return {
    smartSkew: skew(p.smartLongs, p.smartShorts),
    whaleSkew: skew(p.whaleLongs, p.whaleShorts),
  };
}

/** A skew as stored or recorded: null, or a finite number in [−1, 1]. */
export const isSkew = (v: unknown): v is number | null =>
  v === null || (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1);

/** Coins with the largest total notional across listed companies. */
export function topCoinsByNotional(state: MarketState, n: number = MOOD_COINS): string[] {
  const notional = new Map<string, number>();
  for (const rt of state.listed()) {
    for (const p of rt.nav.snapshot.positions) {
      const px = state.marks[p.coin] ?? p.entryPx;
      notional.set(p.coin, (notional.get(p.coin) ?? 0) + Math.abs(p.size) * px);
    }
  }
  return [...notional.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, n)
    .map(([coin]) => coin);
}

/**
 * Street mood: Nansen position-intelligence (cohort positioning) for the top coins, 1 credit per
 * coin, kept as derived skews. A coin whose fetch fails keeps its last reading with that
 * reading's `asOf`, so its age stays visible. `moodAt` becomes the time this run started: every
 * coin read in it has `asOf >= moodAt`.
 */
export async function refreshMood(d: {
  nansen: NansenPort;
  state: MarketState;
  clock: Clock;
  log: Logger;
}): Promise<void> {
  const startedAt = d.clock.now();
  for (const coin of topCoinsByNotional(d.state)) {
    const r = await d.nansen.positionIntelligence(coin);
    if (r.ok) d.state.mood.set(coin, { ...skewsOf(r.value), asOf: d.clock.now() });
    else d.log.warn('mood fetch failed', { coin, error: r.error });
  }
  d.state.moodAt = startedAt;
}

/** Saves the derived street mood (with each coin's asOf) for the next boot. */
export function saveMood(repos: Repos, state: MarketState): void {
  repos.kv.setJson(
    MOOD_SNAPSHOT_KEY,
    [...state.mood].map(([coin, m]) => ({
      coin,
      smartSkew: m.smartSkew,
      whaleSkew: m.whaleSkew,
      asOf: m.asOf,
    })),
  );
}

/** Restores the saved street mood at boot; malformed entries are dropped. Returns how many. */
export function restoreMood(repos: Repos, state: MarketState): number {
  const saved = repos.kv.getJson<unknown>(MOOD_SNAPSHOT_KEY);
  if (!Array.isArray(saved)) return 0;
  let restored = 0;
  for (const e of saved as Array<Record<string, unknown> | null>) {
    if (
      e === null ||
      typeof e !== 'object' ||
      typeof e.coin !== 'string' ||
      e.coin === '' ||
      !isSkew(e.smartSkew) ||
      !isSkew(e.whaleSkew) ||
      typeof e.asOf !== 'number' ||
      !Number.isFinite(e.asOf)
    )
      continue;
    state.mood.set(e.coin, { smartSkew: e.smartSkew, whaleSkew: e.whaleSkew, asOf: e.asOf });
    restored++;
  }
  return restored;
}
