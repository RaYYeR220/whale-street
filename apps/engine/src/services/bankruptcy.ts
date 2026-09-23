import { createPool, multiplier, PARAMS, type Params, settleCompany } from '@whale-street/core';
import { DAY_MS } from '../dates';
import type { Repos } from '../db/repos';
import type { EventBus } from '../events';
import type { CompanyRuntime } from '../market/state';
import type { StatusOps } from '../market/status';
import type { FilingService } from './filings';

export interface BankruptcyDeps {
  repos: Repos;
  filings: FilingService;
  statusOps: StatusOps;
  bus: EventBus;
  params?: Params;
}

export interface BankruptcyService {
  /** BANKRUPT → settle every holder at NAV (multiplier forced to 1) → DELISTED with a cooldown. */
  declare(rt: CompanyRuntime, now: number): void;
}

export function createBankruptcyService(d: BankruptcyDeps): BankruptcyService {
  const params = d.params ?? PARAMS;
  return {
    declare(rt, now) {
      if (rt.status === 'BANKRUPT' || rt.status === 'DELISTED') return;
      const price = rt.nav.nav;
      const multBefore = multiplier(rt.pool);
      rt.status = 'BANKRUPT';
      rt.pool = createPool(rt.pool.l0);
      const season = d.repos.seasons.current();
      const affected = new Set<string>();

      d.repos.tx(() => {
        if (season) {
          const entries = d.repos.holdings.forCompany(season.id, rt.id).map((h) => ({
            playerId: h.playerId,
            holding: {
              longQty: h.longQty,
              longCost: h.longCost,
              shortQty: h.shortQty,
              shortCollateral: h.shortCollateral,
            },
          }));
          for (const line of settleCompany(entries, price)) {
            const cash =
              (d.repos.portfolios.get(line.playerId, season.id)?.cash ?? 0) + line.cashDelta;
            d.repos.portfolios.upsert({ playerId: line.playerId, seasonId: season.id, cash });
            d.repos.holdings.remove(line.playerId, season.id, rt.id);
            d.repos.trades.insert({
              playerId: line.playerId,
              seasonId: season.id,
              companyId: rt.id,
              side: 'SETTLE',
              qty: line.longQty + line.shortQty,
              cash: line.cashDelta,
              avgPrice: price,
              nav: price,
              multBefore,
              multAfter: 1,
              forced: true,
              at: now,
            });
            affected.add(line.playerId);
          }
        }
        rt.status = 'DELISTED';
        rt.haltKind = null;
        rt.haltReason = null;
        rt.delistedAt = now;
        rt.cooldownUntil = now + params.committee.cooldownDays * DAY_MS;
        d.statusOps.persist(rt);
      });

      d.filings.record(rt.id, {
        kind: 'DELISTING',
        at: now,
        provenance: rt.nav.snapshot.provenance,
        detail: `bankrupt: ${affected.size} holder(s) settled at NAV ${price.toFixed(2)}; relisting cooldown ${params.committee.cooldownDays} days`,
      });
      for (const playerId of affected) d.bus.emit({ t: 'player', playerId });
    },
  };
}
