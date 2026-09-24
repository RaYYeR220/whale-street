import {
  computeHp,
  decayPool,
  marginCallCrossed,
  PARAMS,
  type Params,
  tickNav,
} from '@whale-street/core';
import { MINUTE_MS } from '../dates';
import type { Repos } from '../db/repos';
import type { EventBus } from '../events';
import type { FilingService } from '../services/filings';
import type { CompanyRuntime, MarketState } from './state';
import type { StatusOps } from './status';

/** NAV freezes (never extrapolates) when the last HL mids are older than this. */
export const MARKS_DELAY_MS = 10_000;

export interface LoopDeps {
  state: MarketState;
  repos: Repos;
  bus: EventBus;
  filings: FilingService;
  statusOps: StatusOps;
  params?: Params;
  /** Forced COVER of shorts whose buy-back cost reached the auto-cover threshold (wired to the exchange). */
  autoCover?: (rt: CompanyRuntime, now: number) => void;
}

export interface MarketLoop {
  tick(now: number): void;
}

export function createMarketLoop(d: LoopDeps): MarketLoop {
  const params = d.params ?? PARAMS;
  const { state } = d;
  let last: number | null = null;

  const checkHalts = (rt: CompanyRuntime, now: number) => {
    const f = state.flags;
    if (rt.pendingTriggerAt !== null && now - rt.pendingTriggerAt > params.triggerStaleMs) {
      d.statusOps.halt(rt, 'data', 'triggered refresh unresolved for 120 s', now);
    } else if (!f.idle && now - Math.max(rt.lastSnapshotAt, f.wokeAt) > params.staleHaltMs) {
      d.statusOps.halt(rt, 'data', 'no fresh snapshot for 30 min', now);
    } else if (rt.nav.equity < params.minEquityHaltUsd) {
      d.statusOps.halt(rt, 'equity', 'equity below $1,000', now);
    }
  };

  return {
    tick(now) {
      const dt = last === null ? 0 : Math.max(0, now - last);
      last = now;
      const flags = state.flags;
      const delayed = now - state.marksAt > MARKS_DELAY_MS;
      if (delayed !== flags.marksDelayed) {
        flags.marksDelayed = delayed;
        d.bus.emit({ t: 'status' });
      }
      // This tick moves NAV on fresh marks: orders may trade again (see MarketState.paused).
      if (!flags.idle && !delayed) state.awaitingNavTick = false;
      const minute = Math.floor(now / MINUTE_MS);

      for (const rt of state.list()) {
        if (rt.status === 'BANKRUPT' || rt.status === 'DELISTED') continue;
        const navLive = rt.status === 'ACTIVE' || rt.haltKind === 'equity';
        if (navLive && !flags.idle && !delayed) rt.nav = tickNav(rt.nav, state.marks);
        rt.pool = decayPool(rt.pool, dt, params);

        const hp = computeHp(rt.nav.snapshot.positions, state.marks);
        if (marginCallCrossed(rt.hp, hp, params)) {
          d.filings.record(rt.id, {
            kind: 'MARGIN_CALL',
            at: now,
            provenance: rt.nav.snapshot.provenance,
            detail: `health ${Math.round(hp * 100)}% of the way to liquidation`,
          });
        }
        rt.hp = hp;

        if (rt.status === 'ACTIVE') checkHalts(rt, now);
        d.autoCover?.(rt, now);

        if (minute !== rt.lastPointMinute) {
          rt.lastPointMinute = minute;
          d.repos.navPoints.insert({
            companyId: rt.id,
            t: minute * MINUTE_MS,
            nav: rt.nav.nav,
            price: state.price(rt),
          });
          d.statusOps.persist(rt);
        }
      }
      d.bus.emit({ t: 'market', at: now });
    },
  };
}
