import { type Address, evaluateListing, PARAMS, type Params } from '@whale-street/core';
import type { HlInfo } from '@whale-street/hl';
import type { Clock } from '../clock';
import { daysBefore, utcDate } from '../dates';
import type { Repos } from '../db/repos';
import type { Logger } from '../log';
import type { MarketState } from '../market/state';
import type { NansenPort } from '../ports';
import { deniedKey, deniedRecently } from '../services/ipo';
import type { ListingService } from '../services/listing';
import { gatherEvidence } from './evidence';

export const SCOUT_MAX_EVALUATIONS = 5;
/** kv key: engine-clock time of the last completed scout run (seeds the schedule at boot). */
export const SCOUT_LAST_KEY = 'scout:last';

export interface ScoutDeps {
  nansen: NansenPort;
  info: HlInfo;
  state: MarketState;
  repos: Repos;
  clock: Clock;
  log: Logger;
  listing: ListingService;
  targetCompanies: number;
  params?: Params;
  /** Wall clock of the committee's denial memory (shared with the IPO desk); default `clock.now`. */
  wallNow?: () => number;
}

export interface ScoutResult {
  evaluated: number;
  listed: string[];
}

/**
 * Finds new companies. Leaderboard / smart-money rows are used only as a candidate address list
 * held in local variables: they are never stored, logged or served (Nansen redistribution rules).
 */
export async function runScout(d: ScoutDeps): Promise<ScoutResult> {
  const params = d.params ?? PARAMS;
  const result: ScoutResult = { evaluated: 0, listed: [] };
  if (d.state.flags.creditFloor) {
    d.log.warn('scout paused: credit floor');
    return result;
  }
  const need = d.targetCompanies - d.state.listed().length;
  if (need <= 0) return result;

  const now = d.clock.now();
  const wall = d.wallNow?.() ?? now;
  const [board, smart] = await Promise.all([
    d.nansen.perpLeaderboard(daysBefore(now, 30), utcDate(now), 100),
    d.nansen.smartMoneyPerpTrades(24, true, 50),
  ]);
  const candidates = new Set<Address>();
  if (board.ok) {
    for (const row of board.value) {
      if (row.accountValue === null || row.accountValue >= params.committee.minEquityUsd)
        candidates.add(row.address);
    }
  } else d.log.warn('scout: leaderboard unavailable', { error: board.error });
  if (smart.ok) for (const t of smart.value) candidates.add(t.address);
  else d.log.warn('scout: smart-money perp trades unavailable', { error: smart.error });

  for (const address of candidates) {
    if (result.evaluated >= SCOUT_MAX_EVALUATIONS || result.listed.length >= need) break;
    const row = d.repos.companies.get(address);
    if (row && (row.status !== 'DELISTED' || (row.cooldownUntil ?? 0) > now)) continue;
    if (deniedRecently(d.repos, address, wall)) continue;

    result.evaluated++;
    const { ev, positions } = await gatherEvidence(address, d);
    const verdict = evaluateListing(ev, params);
    if (verdict.decision === 'APPROVED' && positions) {
      try {
        const rt = await d.listing.list({
          address,
          source: 'SCOUT',
          rating: verdict.rating,
          prospectus: verdict.prospectus,
          positions,
        });
        result.listed.push(rt.ticker);
      } catch (err) {
        d.log.warn('scout: listing failed', { error: String(err) });
      }
    } else if (verdict.decision === 'DENIED') {
      d.repos.kv.set(deniedKey(address), String(wall));
    }
  }
  d.repos.kv.set(SCOUT_LAST_KEY, String(now));
  d.log.info('scout run', { evaluated: result.evaluated, listed: result.listed.length });
  return result;
}
