import { createPool, multiplier, PARAMS, type Params, settleCompany } from '@whale-street/core';
import { DAY_MS } from '../dates';
import type { Repos } from '../db/repos';
import type { EventBus } from '../events';
import { type Logger, silentLogger } from '../log';
import type { CompanyRuntime } from '../market/state';
import type { StatusOps } from '../market/status';
import type { FilingService } from './filings';

export interface BankruptcyDeps {
  repos: Repos;
  filings: FilingService;
  statusOps: StatusOps;
  bus: EventBus;
  params?: Params;
  log?: Logger;
}

export interface BankruptcyService {
  /**
   * BANKRUPT → settle every holder at NAV (multiplier forced to 1) → DELISTED with a cooldown, in
   * one transaction. Returns false when that transaction fails: the company is left exactly as it
   * was (in memory and in the DB) and stays pending for the next attempt.
   */
  declare(rt: CompanyRuntime, now: number): boolean;
  /** True while a declared bankruptcy has not been settled yet (the next refresh retries it). */
  pending(id: string): boolean;
}

export function createBankruptcyService(d: BankruptcyDeps): BankruptcyService {
  const params = d.params ?? PARAMS;
  const log = d.log ?? silentLogger;
  const unsettled = new Set<string>();
  return {
    declare(rt, now) {
      if (rt.status === 'BANKRUPT' || rt.status === 'DELISTED') return true;
      const price = rt.nav.nav;
      const multBefore = multiplier(rt.pool);
      const before = {
        status: rt.status,
        pool: rt.pool,
        haltKind: rt.haltKind,
        haltReason: rt.haltReason,
        delistedAt: rt.delistedAt,
        cooldownUntil: rt.cooldownUntil,
      };
      const season = d.repos.seasons.current();
      const affected = new Set<string>();

      try {
        rt.status = 'BANKRUPT';
        rt.pool = createPool(rt.pool.l0);
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
      } catch (err) {
        // The transaction rolled the DB back; put the runtime back too and retry later.
        Object.assign(rt, before);
        unsettled.add(rt.id);
        log.error('bankruptcy settlement failed; company left as it was for a retry', {
          company: rt.ticker,
          error: String(err),
        });
        return false;
      }
      unsettled.delete(rt.id);

      d.filings.record(rt.id, {
        kind: 'DELISTING',
        at: now,
        provenance: rt.nav.snapshot.provenance,
        detail: `bankrupt: ${affected.size} holder(s) settled at NAV ${price.toFixed(2)}; relisting cooldown ${params.committee.cooldownDays} days`,
      });
      for (const playerId of affected) d.bus.emit({ t: 'player', playerId });
      return true;
    },
    pending: (id) => unsettled.has(id.toLowerCase()),
  };
}
