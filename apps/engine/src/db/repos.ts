import type { CallRecord } from '@whale-street/nansen';
import { and, desc, eq, gt, gte, inArray, lte } from 'drizzle-orm';
import type { Db } from './index';
import {
  agentKeys,
  companies,
  filings,
  holdings,
  ipoApps,
  ipoSpend,
  kv,
  mirrorOrders,
  nansenCalls,
  navPoints,
  players,
  portfolios,
  seasonResults,
  seasons,
  trades,
} from './schema';

export type CompanyRow = typeof companies.$inferSelect;
export type NavPointRow = typeof navPoints.$inferSelect;
export type FilingRow = typeof filings.$inferSelect;
export type NewFiling = typeof filings.$inferInsert;
export type PlayerRow = typeof players.$inferSelect;
export type PortfolioRow = typeof portfolios.$inferSelect;
export type HoldingRow = typeof holdings.$inferSelect;
export type TradeRow = typeof trades.$inferSelect;
export type NewTrade = typeof trades.$inferInsert;
export type SeasonRow = typeof seasons.$inferSelect;
export type SeasonResultRow = typeof seasonResults.$inferSelect;
export type IpoAppRow = typeof ipoApps.$inferSelect;
export type NansenCallRow = typeof nansenCalls.$inferSelect;
export type MirrorOrderRow = typeof mirrorOrders.$inferSelect;
export type AgentKeyRow = typeof agentKeys.$inferSelect;

export interface Repos {
  /** Runs fn inside one SQLite transaction (rolled back if fn throws). */
  tx<T>(fn: () => T): T;
  companies: {
    upsert(row: CompanyRow): void;
    get(id: string): CompanyRow | undefined;
    byTicker(ticker: string): CompanyRow | undefined;
    all(): CompanyRow[];
    tickers(): Set<string>;
  };
  navPoints: {
    insert(p: NavPointRow): void;
    history(companyId: string, sinceT: number): NavPointRow[];
    atOrBefore(companyId: string, t: number): NavPointRow | undefined;
  };
  filings: {
    insert(f: NewFiling): FilingRow;
    recent(limit: number, companyId?: string): FilingRow[];
  };
  players: {
    insert(p: PlayerRow): void;
    get(id: string): PlayerRow | undefined;
    byTokenHash(hash: string): PlayerRow | undefined;
    byHandle(handle: string): PlayerRow | undefined;
    setWallet(id: string, address: string): void;
    many(ids: readonly string[]): PlayerRow[];
  };
  portfolios: {
    get(playerId: string, seasonId: number): PortfolioRow | undefined;
    upsert(row: PortfolioRow): void;
    forSeason(seasonId: number): PortfolioRow[];
  };
  holdings: {
    get(playerId: string, seasonId: number, companyId: string): HoldingRow | undefined;
    upsert(row: HoldingRow): void;
    remove(playerId: string, seasonId: number, companyId: string): void;
    forPlayer(playerId: string, seasonId: number): HoldingRow[];
    forCompany(seasonId: number, companyId: string): HoldingRow[];
    forSeason(seasonId: number): HoldingRow[];
    shortsFor(seasonId: number, companyId: string): HoldingRow[];
  };
  trades: {
    insert(t: NewTrade): void;
    recent(limit: number, companyId?: string): TradeRow[];
    forPlayer(playerId: string, limit: number): TradeRow[];
  };
  ipoSpend: {
    get(playerId: string, companyId: string, listedAt: number): number;
    add(playerId: string, companyId: string, listedAt: number, amount: number): void;
  };
  seasons: {
    current(): SeasonRow | undefined;
    get(id: number): SeasonRow | undefined;
    all(): SeasonRow[];
    insert(row: SeasonRow): void;
    close(id: number): void;
  };
  seasonResults: {
    insertMany(rows: SeasonResultRow[]): void;
    forSeason(seasonId: number): SeasonResultRow[];
    forPlayer(playerId: string): SeasonResultRow[];
  };
  ipoApps: {
    insert(row: IpoAppRow): void;
    get(id: string): IpoAppRow | undefined;
    update(id: string, patch: Partial<Omit<IpoAppRow, 'id'>>): void;
    recent(limit: number): IpoAppRow[];
    countByPlayerSince(playerId: string, since: number): number;
  };
  nansenCalls: {
    insert(r: CallRecord): void;
    recent(limit: number): NansenCallRow[];
    get(id: string): NansenCallRow | undefined;
  };
  mirrorOrders: {
    insert(row: MirrorOrderRow): void;
    get(id: string): MirrorOrderRow | undefined;
    update(id: string, patch: Partial<Omit<MirrorOrderRow, 'id'>>): void;
    byGroup(groupId: string): MirrorOrderRow[];
    byPlayer(playerId: string, limit: number): MirrorOrderRow[];
    ordersSince(playerId: string, since: number): MirrorOrderRow[];
  };
  agentKeys: {
    upsert(row: AgentKeyRow): void;
    get(playerId: string): AgentKeyRow | undefined;
  };
  kv: {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
    getJson<T>(key: string): T | undefined;
    setJson(key: string, value: unknown): void;
    delete(key: string): void;
  };
}

export function createRepos({ sqlite, db }: Db): Repos {
  return {
    tx: (fn) => sqlite.transaction(fn)(),

    companies: {
      upsert: (row) => {
        db.insert(companies)
          .values(row)
          .onConflictDoUpdate({ target: companies.id, set: row })
          .run();
      },
      get: (id) => db.select().from(companies).where(eq(companies.id, id)).get(),
      byTicker: (ticker) => db.select().from(companies).where(eq(companies.ticker, ticker)).get(),
      all: () => db.select().from(companies).all(),
      tickers: () =>
        new Set(
          db
            .select({ t: companies.ticker })
            .from(companies)
            .all()
            .map((r) => r.t),
        ),
    },

    navPoints: {
      insert: (p) => {
        db.insert(navPoints).values(p).onConflictDoNothing().run();
      },
      history: (companyId, sinceT) =>
        db
          .select()
          .from(navPoints)
          .where(and(eq(navPoints.companyId, companyId), gte(navPoints.t, sinceT)))
          .orderBy(navPoints.t)
          .all(),
      atOrBefore: (companyId, t) =>
        db
          .select()
          .from(navPoints)
          .where(and(eq(navPoints.companyId, companyId), lte(navPoints.t, t)))
          .orderBy(desc(navPoints.t))
          .limit(1)
          .get(),
    },

    filings: {
      insert: (f) => db.insert(filings).values(f).returning().get(),
      recent: (limit, companyId) =>
        db
          .select()
          .from(filings)
          .where(companyId ? eq(filings.companyId, companyId) : undefined)
          .orderBy(desc(filings.id))
          .limit(limit)
          .all(),
    },

    players: {
      insert: (p) => {
        db.insert(players).values(p).run();
      },
      get: (id) => db.select().from(players).where(eq(players.id, id)).get(),
      byTokenHash: (hash) => db.select().from(players).where(eq(players.tokenHash, hash)).get(),
      byHandle: (handle) => db.select().from(players).where(eq(players.handle, handle)).get(),
      setWallet: (id, address) => {
        db.update(players).set({ walletAddress: address }).where(eq(players.id, id)).run();
      },
      many: (ids) =>
        ids.length === 0
          ? []
          : db
              .select()
              .from(players)
              .where(inArray(players.id, [...ids]))
              .all(),
    },

    portfolios: {
      get: (playerId, seasonId) =>
        db
          .select()
          .from(portfolios)
          .where(and(eq(portfolios.playerId, playerId), eq(portfolios.seasonId, seasonId)))
          .get(),
      upsert: (row) => {
        db.insert(portfolios)
          .values(row)
          .onConflictDoUpdate({
            target: [portfolios.playerId, portfolios.seasonId],
            set: { cash: row.cash },
          })
          .run();
      },
      forSeason: (seasonId) =>
        db.select().from(portfolios).where(eq(portfolios.seasonId, seasonId)).all(),
    },

    holdings: {
      get: (playerId, seasonId, companyId) =>
        db
          .select()
          .from(holdings)
          .where(
            and(
              eq(holdings.playerId, playerId),
              eq(holdings.seasonId, seasonId),
              eq(holdings.companyId, companyId),
            ),
          )
          .get(),
      upsert: (row) => {
        db.insert(holdings)
          .values(row)
          .onConflictDoUpdate({
            target: [holdings.playerId, holdings.seasonId, holdings.companyId],
            set: {
              longQty: row.longQty,
              longCost: row.longCost,
              shortQty: row.shortQty,
              shortCollateral: row.shortCollateral,
            },
          })
          .run();
      },
      remove: (playerId, seasonId, companyId) => {
        db.delete(holdings)
          .where(
            and(
              eq(holdings.playerId, playerId),
              eq(holdings.seasonId, seasonId),
              eq(holdings.companyId, companyId),
            ),
          )
          .run();
      },
      forPlayer: (playerId, seasonId) =>
        db
          .select()
          .from(holdings)
          .where(and(eq(holdings.playerId, playerId), eq(holdings.seasonId, seasonId)))
          .all(),
      forCompany: (seasonId, companyId) =>
        db
          .select()
          .from(holdings)
          .where(and(eq(holdings.seasonId, seasonId), eq(holdings.companyId, companyId)))
          .all(),
      forSeason: (seasonId) =>
        db.select().from(holdings).where(eq(holdings.seasonId, seasonId)).all(),
      shortsFor: (seasonId, companyId) =>
        db
          .select()
          .from(holdings)
          .where(
            and(
              eq(holdings.seasonId, seasonId),
              eq(holdings.companyId, companyId),
              gt(holdings.shortQty, 0),
            ),
          )
          .all(),
    },

    trades: {
      insert: (t) => {
        db.insert(trades).values(t).run();
      },
      recent: (limit, companyId) =>
        db
          .select()
          .from(trades)
          .where(companyId ? eq(trades.companyId, companyId) : undefined)
          .orderBy(desc(trades.id))
          .limit(limit)
          .all(),
      forPlayer: (playerId, limit) =>
        db
          .select()
          .from(trades)
          .where(eq(trades.playerId, playerId))
          .orderBy(desc(trades.id))
          .limit(limit)
          .all(),
    },

    ipoSpend: {
      get: (playerId, companyId, listedAt) =>
        db
          .select()
          .from(ipoSpend)
          .where(
            and(
              eq(ipoSpend.playerId, playerId),
              eq(ipoSpend.companyId, companyId),
              eq(ipoSpend.listedAt, listedAt),
            ),
          )
          .get()?.spent ?? 0,
      add: (playerId, companyId, listedAt, amount) => {
        const spent =
          amount +
          (db
            .select()
            .from(ipoSpend)
            .where(
              and(
                eq(ipoSpend.playerId, playerId),
                eq(ipoSpend.companyId, companyId),
                eq(ipoSpend.listedAt, listedAt),
              ),
            )
            .get()?.spent ?? 0);
        db.insert(ipoSpend)
          .values({ playerId, companyId, listedAt, spent })
          .onConflictDoUpdate({
            target: [ipoSpend.playerId, ipoSpend.companyId, ipoSpend.listedAt],
            set: { spent },
          })
          .run();
      },
    },

    seasons: {
      current: () =>
        db
          .select()
          .from(seasons)
          .where(eq(seasons.status, 'ACTIVE'))
          .orderBy(desc(seasons.id))
          .limit(1)
          .get(),
      get: (id) => db.select().from(seasons).where(eq(seasons.id, id)).get(),
      all: () => db.select().from(seasons).orderBy(desc(seasons.id)).all(),
      insert: (row) => {
        db.insert(seasons).values(row).run();
      },
      close: (id) => {
        db.update(seasons).set({ status: 'CLOSED' }).where(eq(seasons.id, id)).run();
      },
    },

    seasonResults: {
      insertMany: (rows) => {
        if (rows.length > 0) db.insert(seasonResults).values(rows).run();
      },
      forSeason: (seasonId) =>
        db
          .select()
          .from(seasonResults)
          .where(eq(seasonResults.seasonId, seasonId))
          .orderBy(seasonResults.rank)
          .all(),
      forPlayer: (playerId) =>
        db
          .select()
          .from(seasonResults)
          .where(eq(seasonResults.playerId, playerId))
          .orderBy(desc(seasonResults.seasonId))
          .all(),
    },

    ipoApps: {
      insert: (row) => {
        db.insert(ipoApps).values(row).run();
      },
      get: (id) => db.select().from(ipoApps).where(eq(ipoApps.id, id)).get(),
      update: (id, patch) => {
        db.update(ipoApps).set(patch).where(eq(ipoApps.id, id)).run();
      },
      recent: (limit) =>
        db.select().from(ipoApps).orderBy(desc(ipoApps.createdAt)).limit(limit).all(),
      countByPlayerSince: (playerId, since) =>
        db
          .select({ id: ipoApps.id })
          .from(ipoApps)
          .where(and(eq(ipoApps.playerId, playerId), gte(ipoApps.createdAt, since)))
          .all().length,
    },

    nansenCalls: {
      insert: (r) => {
        db.insert(nansenCalls)
          .values({
            id: r.id,
            method: r.method,
            path: r.path,
            requestHash: r.requestHash,
            status: r.status,
            credits: r.creditsUsed,
            latencyMs: r.latencyMs,
            at: r.at,
            responseHash: r.responseHash,
            error: r.error,
            attempts: r.attempts,
          })
          .onConflictDoNothing()
          .run();
      },
      recent: (limit) =>
        db.select().from(nansenCalls).orderBy(desc(nansenCalls.at)).limit(limit).all(),
      get: (id) => db.select().from(nansenCalls).where(eq(nansenCalls.id, id)).get(),
    },

    mirrorOrders: {
      insert: (row) => {
        db.insert(mirrorOrders).values(row).run();
      },
      get: (id) => db.select().from(mirrorOrders).where(eq(mirrorOrders.id, id)).get(),
      update: (id, patch) => {
        db.update(mirrorOrders).set(patch).where(eq(mirrorOrders.id, id)).run();
      },
      byGroup: (groupId) =>
        db
          .select()
          .from(mirrorOrders)
          .where(eq(mirrorOrders.groupId, groupId))
          .orderBy(mirrorOrders.stepIndex)
          .all(),
      byPlayer: (playerId, limit) =>
        db
          .select()
          .from(mirrorOrders)
          .where(eq(mirrorOrders.playerId, playerId))
          .orderBy(desc(mirrorOrders.createdAt))
          .limit(limit)
          .all(),
      ordersSince: (playerId, since) =>
        db
          .select()
          .from(mirrorOrders)
          .where(
            and(
              eq(mirrorOrders.playerId, playerId),
              eq(mirrorOrders.kind, 'order'),
              gte(mirrorOrders.createdAt, since),
            ),
          )
          .all(),
    },

    agentKeys: {
      upsert: (row) => {
        db.insert(agentKeys)
          .values(row)
          .onConflictDoUpdate({ target: agentKeys.playerId, set: row })
          .run();
      },
      get: (playerId) => db.select().from(agentKeys).where(eq(agentKeys.playerId, playerId)).get(),
    },

    kv: {
      get: (key) => db.select().from(kv).where(eq(kv.key, key)).get()?.value,
      set: (key, value) => {
        db.insert(kv)
          .values({ key, value })
          .onConflictDoUpdate({ target: kv.key, set: { value } })
          .run();
      },
      getJson<T>(key: string): T | undefined {
        const v = db.select().from(kv).where(eq(kv.key, key)).get()?.value;
        return v === undefined ? undefined : (JSON.parse(v) as T);
      },
      setJson: (key, value) => {
        const v = JSON.stringify(value);
        db.insert(kv)
          .values({ key, value: v })
          .onConflictDoUpdate({ target: kv.key, set: { value: v } })
          .run();
      },
      delete: (key) => {
        db.delete(kv).where(eq(kv.key, key)).run();
      },
    },
  };
}
