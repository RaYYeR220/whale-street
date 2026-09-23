import { multiplier, settleHolding } from '@whale-street/core';
import { DAY_MS } from '../dates';
import type { Repos, SeasonRow } from '../db/repos';
import type { EventBus } from '../events';
import type { MarketState } from '../market/state';

export interface SeasonService {
  /** The ACTIVE season, created (season 1, or last + 1) when none exists. */
  ensure(now: number): SeasonRow;
  /** Ends the ACTIVE season when its time is up; returns true when a rollover happened. */
  maybeRollover(now: number): boolean;
}

export function createSeasonService(d: {
  repos: Repos;
  state: MarketState;
  bus: EventBus;
  seasonDays: number;
}): SeasonService {
  const lengthMs = d.seasonDays * DAY_MS;

  const create = (id: number, now: number): SeasonRow => {
    const row: SeasonRow = { id, startedAt: now, endsAt: now + lengthMs, status: 'ACTIVE' };
    d.repos.seasons.insert(row);
    return row;
  };

  const ensure = (now: number): SeasonRow => {
    const current = d.repos.seasons.current();
    if (current) return current;
    const last = d.repos.seasons.all()[0];
    return create((last?.id ?? 0) + 1, now);
  };

  return {
    ensure,
    maybeRollover(now) {
      const season = d.repos.seasons.current();
      if (!season || now < season.endsAt) return false;
      d.repos.tx(() => {
        const cash = new Map(
          d.repos.portfolios.forSeason(season.id).map((p) => [p.playerId, p.cash]),
        );
        for (const h of d.repos.holdings.forSeason(season.id)) {
          const rt = d.state.get(h.companyId);
          const price = rt ? d.state.price(rt) : 0;
          const delta = settleHolding(h, price);
          cash.set(h.playerId, (cash.get(h.playerId) ?? 0) + delta);
          d.repos.holdings.remove(h.playerId, season.id, h.companyId);
          d.repos.trades.insert({
            playerId: h.playerId,
            seasonId: season.id,
            companyId: h.companyId,
            side: 'SETTLE',
            qty: h.longQty + h.shortQty,
            cash: delta,
            avgPrice: price,
            nav: rt?.nav.nav ?? 0,
            multBefore: rt ? multiplier(rt.pool) : 1,
            multAfter: rt ? multiplier(rt.pool) : 1,
            forced: true,
            at: now,
          });
        }
        const ranked = [...cash.entries()].sort((a, b) => b[1] - a[1]);
        for (const [playerId, value] of ranked)
          d.repos.portfolios.upsert({ playerId, seasonId: season.id, cash: value });
        d.repos.seasonResults.insertMany(
          ranked.map(([playerId, netWorth], i) => ({
            seasonId: season.id,
            playerId,
            netWorth,
            rank: i + 1,
          })),
        );
        d.repos.seasons.close(season.id);
        create(season.id + 1, now);
      });
      d.bus.emit({ t: 'status' });
      return true;
    },
  };
}
