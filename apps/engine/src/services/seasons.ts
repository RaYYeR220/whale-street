import { multiplier, settleHolding } from '@whale-street/core';
import { DAY_MS } from '../dates';
import type { Repos, SeasonRow } from '../db/repos';
import type { EventBus } from '../events';
import { type Logger, silentLogger } from '../log';
import type { MarketState } from '../market/state';

export interface RankRow {
  playerId: string;
  /** null (unknown) ranks below every known net worth. */
  netWorth: number | null;
  /** When the player signed up; the earlier player wins a tie. */
  createdAt: number;
}

/** Rank order: higher net worth first, then the earlier player, then the lower player id. */
export function compareRank(a: RankRow, b: RankRow): number {
  const worth = (r: RankRow) => r.netWorth ?? Number.NEGATIVE_INFINITY;
  if (worth(a) !== worth(b)) return worth(b) - worth(a);
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0;
}

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
  log?: Logger;
}): SeasonService {
  const lengthMs = d.seasonDays * DAY_MS;
  const log = d.log ?? silentLogger;

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
          if (!rt) {
            // No price for it: never settle at a made-up one. The holding row stays as it is.
            log.error('season rollover: company not in memory; holding left unsettled', {
              company: h.companyId,
              player: h.playerId,
              season: season.id,
            });
            continue;
          }
          const price = d.state.price(rt);
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
            nav: rt.nav.nav,
            multBefore: multiplier(rt.pool),
            multAfter: multiplier(rt.pool),
            forced: true,
            at: now,
          });
        }
        const joined = new Map(
          d.repos.players.many([...cash.keys()]).map((p) => [p.id, p.createdAt]),
        );
        const ranked = [...cash.entries()]
          .map(([playerId, netWorth]) => ({
            playerId,
            netWorth,
            createdAt: joined.get(playerId) ?? Number.POSITIVE_INFINITY,
          }))
          .sort(compareRank);
        for (const r of ranked)
          d.repos.portfolios.upsert({
            playerId: r.playerId,
            seasonId: season.id,
            cash: r.netWorth,
          });
        d.repos.seasonResults.insertMany(
          ranked.map((r, i) => ({
            seasonId: season.id,
            playerId: r.playerId,
            netWorth: r.netWorth,
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
