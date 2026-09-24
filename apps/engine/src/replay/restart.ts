import { type Address, computeHp, createPool, initNav } from '@whale-street/core';
import type { ReplayFeed } from '@whale-street/hl';
import type { Engine } from '../engine';
import { fetchPositions } from '../ingest/positions';
import type { CompanyRuntime } from '../market/state';
import type { ReplayMood } from './mood';
import type { SeedCompany } from './session';

/** Resets a company to its first recorded snapshot: NAV 100, multiplier 1, ACTIVE. */
function reinitialize(e: Engine, rt: CompanyRuntime, now: number, detail: string): void {
  rt.nav = initNav({ ...rt.firstSnapshot, fetchedAt: now }, e.params.navStart);
  rt.pool = createPool(rt.pool.l0);
  rt.hp = computeHp(rt.firstSnapshot.positions, e.state.marks);
  rt.status = 'ACTIVE';
  rt.haltKind = null;
  rt.haltReason = null;
  rt.lastSnapshotAt = now;
  rt.pendingTriggerAt = null;
  rt.lastPointMinute = -1;
  rt.delistedAt = null;
  rt.cooldownUntil = null;
  e.statusOps.persist(rt);
  e.filings.record(rt.id, {
    kind: 'RESUME',
    at: now,
    provenance: rt.firstSnapshot.provenance,
    detail,
  });
}

/** REPLAY boot: lists every recorded company without a committee run (source SEEDED). */
export async function seedReplayCompanies(
  e: Engine,
  seeds: readonly SeedCompany[],
): Promise<number> {
  let listed = 0;
  for (const seed of seeds) {
    const address = seed.address.toLowerCase() as Address;
    const existing = e.state.get(address);
    if (existing) {
      reinitialize(e, existing, e.clock.now(), 'replay started');
      listed++;
      continue;
    }
    const positions = await fetchPositions(address, {
      nansen: e.nansen,
      info: e.hl.info,
      creditSaver: false,
    });
    if (!positions.ok) {
      e.log.warn('replay seed skipped: no recorded positions', { address, error: positions.error });
      continue;
    }
    try {
      await e.listing.list({
        address,
        source: 'SEEDED',
        rating: null,
        prospectus: null,
        positions: positions.value,
        anchorDate: seed.anchorDate,
      });
      listed++;
    } catch (err) {
      e.log.warn('replay seed skipped: listing failed', { address, error: String(err) });
    }
  }
  return listed;
}

/**
 * REPLAY loop wrap: re-base every engine-clock timer on the rewound clock (due times from the
 * previous loop would lie beyond the loop's end and never fire), rewind the feed and the street
 * mood and replay their first records (so marks and mood are the recording's opening ones, not
 * the previous loop's closing ones), then reset every company to its first snapshot. Players
 * keep their portfolios.
 */
export function restartReplay(e: Engine, r: { feed: ReplayFeed; mood: ReplayMood }): void {
  const now = e.clock.now();
  e.resetTimers(now);
  r.feed.rewind();
  r.feed.advance();
  e.state.mood.clear();
  r.mood.rewind();
  r.mood.advance();
  for (const rt of e.state.list()) reinitialize(e, rt, now, 'replay restarted');
}
