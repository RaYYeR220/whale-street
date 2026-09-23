import {
  netWorth as computeNetWorth,
  type ExecContext,
  executeOrder,
  type Holding,
  holdingValue,
  isValidPx,
  needsAutoCover,
  type OrderSide,
  PARAMS,
  type Params,
  type Portfolio,
  qtyForCash,
  quoteBuy,
  quoteSell,
  type RejectReason,
  sharePrice,
} from '@whale-street/core';
import type { Clock } from '../clock';
import type { HoldingRow, Repos } from '../db/repos';
import type { EventBus } from '../events';
import { type Logger, silentLogger } from '../log';
import { type CompanyRuntime, type MarketState, rowFromRuntime } from '../market/state';
import type { PlayerKind } from '../types';
import type { SeasonService } from './seasons';

export interface OrderRequest {
  ticker: string;
  side: OrderSide;
  /** Share quantity; for BUY, `cash` may be given instead. */
  qty?: number;
  cash?: number;
}

export type ExchangeErrorCode = RejectReason | 'UNKNOWN_TICKER' | 'UNKNOWN_PLAYER' | 'BAD_REQUEST';

export interface FillView {
  ticker: string;
  side: OrderSide;
  qty: number;
  cash: number;
  avgPrice: number;
  nav: number;
  multiplierBefore: number;
  multiplierAfter: number;
  price: number;
}

export interface HoldingView extends Holding {
  companyId: string;
  ticker: string;
  /** null when this company has no live price right now (see PortfolioView.netWorthReason). */
  price: number | null;
  value: number | null;
}

export interface PortfolioView {
  playerId: string;
  seasonId: number;
  cash: number;
  /** null (never a fabricated number) when any held company's price is currently unavailable. */
  netWorth: number | null;
  netWorthReason: string | null;
  holdings: HoldingView[];
}

export type OrderResult =
  | { ok: true; fill: FillView; portfolio: PortfolioView }
  | { ok: false; code: ExchangeErrorCode; message: string };

export type QuoteResult =
  | {
      ok: true;
      ticker: string;
      side: OrderSide;
      qty: number;
      cash: number;
      avgPrice: number;
      price: number;
      priceAfter: number;
    }
  | { ok: false; code: ExchangeErrorCode; message: string };

export interface LeaderboardEntry {
  rank: number;
  playerId: string;
  handle: string;
  kind: PlayerKind;
  /** null (never a fabricated number) when any held company's price is currently unavailable. */
  netWorth: number | null;
}

export interface HolderView {
  handle: string;
  kind: PlayerKind;
  longQty: number;
  shortQty: number;
}

export interface ExchangeService {
  quote(ticker: string, side: OrderSide, qty: number): QuoteResult;
  placeOrder(playerId: string, req: OrderRequest): OrderResult;
  /** Forced COVER of every short in this company whose buy-back reached 95% of its collateral. */
  autoCover(rt: CompanyRuntime, now: number): void;
  portfolio(playerId: string): PortfolioView;
  leaderboard(limit: number): LeaderboardEntry[];
  holders(companyId: string): HolderView[];
}

export interface ExchangeDeps {
  state: MarketState;
  repos: Repos;
  bus: EventBus;
  clock: Clock;
  seasons: SeasonService;
  params?: Params;
  /** The trades table has no write-off column; a forced cover's write-off is logged, not persisted. */
  log?: Logger;
}

const MESSAGES: Record<ExchangeErrorCode, string> = {
  COMPANY_NOT_TRADING: 'trading is halted for this company',
  INVALID_QTY: 'quantity must be a positive number',
  INVALID_NAV: 'no valid NAV for this company',
  INSUFFICIENT_CASH: 'not enough cash',
  INSUFFICIENT_SHARES: 'not enough shares',
  INSUFFICIENT_LIQUIDITY: 'order too large for the pool',
  COVER_SHORT_FIRST: 'cover your short before buying',
  CLOSE_LONG_FIRST: 'sell your shares before shorting',
  IPO_ALLOCATION_EXCEEDED: 'IPO allocation exceeded (10% of season cash in the first 60 s)',
  UNKNOWN_TICKER: 'no such ticker',
  UNKNOWN_PLAYER: 'no such player',
  BAD_REQUEST: 'give qty, or cash for a BUY',
};

const fail = (code: ExchangeErrorCode) => ({ ok: false as const, code, message: MESSAGES[code] });

const toHolding = (h: HoldingRow): Holding => ({
  longQty: h.longQty,
  longCost: h.longCost,
  shortQty: h.shortQty,
  shortCollateral: h.shortCollateral,
});

export function createExchange(d: ExchangeDeps): ExchangeService {
  const params = d.params ?? PARAMS;
  const log = d.log ?? silentLogger;
  const { state, repos } = d;

  /** null (never 0) when the company has no live share price right now — never fabricate a value. */
  const priceOf = (companyId: string): number | null => {
    const rt = state.get(companyId);
    if (!rt) return null;
    const p = state.price(rt);
    return isValidPx(p) ? p : null;
  };

  const portfolio = (playerId: string): PortfolioView => {
    const season = d.seasons.ensure(d.clock.now());
    const cash = repos.portfolios.get(playerId, season.id)?.cash ?? params.seasonStartCash;
    const rows = repos.holdings.forPlayer(playerId, season.id);
    const prices: Record<string, number> = {};
    const missingTickers: string[] = [];
    const holdings = rows.map((h): HoldingView => {
      const price = priceOf(h.companyId);
      const ticker = state.get(h.companyId)?.ticker ?? '?';
      if (price === null) missingTickers.push(ticker);
      else prices[h.companyId] = price;
      return {
        ...toHolding(h),
        companyId: h.companyId,
        ticker,
        price,
        value: price === null ? null : holdingValue(toHolding(h), price),
      };
    });
    const pf: Portfolio = {
      cash,
      holdings: Object.fromEntries(rows.map((h) => [h.companyId, toHolding(h)])),
    };
    const net = computeNetWorth(pf, prices);
    return {
      playerId,
      seasonId: season.id,
      cash,
      netWorth: net,
      netWorthReason:
        net === null ? `missing live price for ${[...new Set(missingTickers)].join(', ')}` : null,
      holdings,
    };
  };

  const execute = (
    playerId: string,
    rt: CompanyRuntime,
    side: OrderSide,
    qty: number,
    ctx: ExecContext,
    now: number,
  ): OrderResult => {
    const player = repos.players.get(playerId);
    if (!player) return fail('UNKNOWN_PLAYER');
    const season = d.seasons.ensure(now);
    const prevPool = rt.pool;
    let result: OrderResult;
    try {
      result = repos.tx((): OrderResult => {
        const cash = repos.portfolios.get(playerId, season.id)?.cash ?? params.seasonStartCash;
        const row = repos.holdings.get(playerId, season.id, rt.id);
        const pf: Portfolio = { cash, holdings: row ? { [rt.id]: toHolding(row) } : {} };
        const r = executeOrder(pf, rt.pool, { companyId: rt.id, side, qty }, ctx, params);
        if (!r.ok) return fail(r.reason);
        repos.portfolios.upsert({ playerId, seasonId: season.id, cash: r.portfolio.cash });
        const h = r.portfolio.holdings[rt.id];
        if (h) repos.holdings.upsert({ playerId, seasonId: season.id, companyId: rt.id, ...h });
        else repos.holdings.remove(playerId, season.id, rt.id);
        repos.trades.insert({
          playerId,
          seasonId: season.id,
          companyId: rt.id,
          side,
          qty: r.fill.qty,
          cash: r.fill.cash,
          avgPrice: r.fill.avgPrice,
          nav: r.fill.nav,
          multBefore: r.fill.multiplierBefore,
          multAfter: r.fill.multiplierAfter,
          forced: ctx.forced === true,
          at: now,
        });
        if (r.fill.writeOffUsd > 0) {
          // The trades table has no write-off column (the schema predates this Fill field);
          // logging is the minimal way to keep the amount observable without a migration.
          log.warn('forced cover write-off', {
            playerId,
            companyId: rt.id,
            writeOffUsd: r.fill.writeOffUsd,
          });
        }
        if (ctx.ipoRemainingCash !== undefined)
          repos.ipoSpend.add(playerId, rt.id, rt.listedAt, r.fill.cash);
        rt.pool = r.pool;
        repos.companies.upsert(rowFromRuntime(rt));
        const fill: FillView = {
          ticker: rt.ticker,
          side,
          qty: r.fill.qty,
          cash: r.fill.cash,
          avgPrice: r.fill.avgPrice,
          nav: r.fill.nav,
          multiplierBefore: r.fill.multiplierBefore,
          multiplierAfter: r.fill.multiplierAfter,
          price: sharePrice(rt.nav.nav, r.pool),
        };
        return { ok: true, fill, portfolio: portfolio(playerId) };
      });
    } catch (err) {
      rt.pool = prevPool;
      throw err;
    }
    if (result.ok) {
      d.bus.emit({
        t: 'tape',
        trade: {
          ticker: rt.ticker,
          side,
          qty: result.fill.qty,
          avgPrice: result.fill.avgPrice,
          cash: result.fill.cash,
          handle: player.handle,
          kind: player.kind,
          forced: ctx.forced === true,
          at: now,
        },
      });
      d.bus.emit({ t: 'player', playerId });
    }
    return result;
  };

  return {
    quote(ticker, side, qty) {
      const rt = state.byTicker(ticker);
      if (!rt) return fail('UNKNOWN_TICKER');
      const q =
        side === 'BUY' || side === 'COVER'
          ? quoteBuy(rt.pool, qty, rt.nav.nav, params)
          : quoteSell(rt.pool, qty, rt.nav.nav, params);
      if (!q.ok) return fail(q.error);
      return {
        ok: true,
        ticker: rt.ticker,
        side,
        qty,
        cash: q.cash,
        avgPrice: q.cash / qty,
        price: state.price(rt),
        priceAfter: sharePrice(rt.nav.nav, q.pool),
      };
    },

    placeOrder(playerId, req) {
      const rt = state.byTicker(req.ticker);
      if (!rt) return fail('UNKNOWN_TICKER');
      const now = d.clock.now();
      let qty = req.qty;
      if (qty === undefined) {
        if (req.side !== 'BUY' || req.cash === undefined) return fail('BAD_REQUEST');
        qty = qtyForCash(rt.pool, req.cash, rt.nav.nav, params);
        if (!(qty > 0)) return fail('INVALID_QTY');
      }
      const ctx: ExecContext = { status: rt.status, nav: rt.nav.nav };
      if (req.side === 'BUY' && now < rt.ipoUntil) {
        ctx.ipoRemainingCash =
          params.ipoCapFrac * params.seasonStartCash -
          repos.ipoSpend.get(playerId, rt.id, rt.listedAt);
      }
      return execute(playerId, rt, req.side, qty, ctx, now);
    },

    autoCover(rt, now) {
      const season = repos.seasons.current();
      if (!season) return;
      for (const h of repos.holdings.shortsFor(season.id, rt.id)) {
        if (!needsAutoCover(toHolding(h), rt.pool, rt.nav.nav, params)) continue;
        execute(
          h.playerId,
          rt,
          'COVER',
          h.shortQty,
          { status: rt.status, nav: rt.nav.nav, forced: true },
          now,
        );
      }
    },

    portfolio,

    leaderboard(limit) {
      const season = d.seasons.ensure(d.clock.now());
      const cashByPlayer = new Map(
        repos.portfolios.forSeason(season.id).map((p) => [p.playerId, p.cash]),
      );
      const holdingsByPlayer = new Map<string, Record<string, Holding>>();
      for (const h of repos.holdings.forSeason(season.id)) {
        const m = holdingsByPlayer.get(h.playerId) ?? {};
        m[h.companyId] = toHolding(h);
        holdingsByPlayer.set(h.playerId, m);
      }
      const prices: Record<string, number> = {};
      for (const rt of state.list()) {
        const p = priceOf(rt.id);
        if (p !== null) prices[rt.id] = p;
      }
      const ids = new Set([...cashByPlayer.keys(), ...holdingsByPlayer.keys()]);
      const players = new Map(repos.players.many([...ids]).map((p) => [p.id, p]));
      const rows = [...ids].map((playerId) => {
        const pf: Portfolio = {
          cash: cashByPlayer.get(playerId) ?? params.seasonStartCash,
          holdings: holdingsByPlayer.get(playerId) ?? {},
        };
        return { playerId, netWorth: computeNetWorth(pf, prices) };
      });
      rows.sort(
        (a, b) =>
          (b.netWorth ?? Number.NEGATIVE_INFINITY) - (a.netWorth ?? Number.NEGATIVE_INFINITY),
      );
      return rows.slice(0, limit).map((r, i) => ({
        rank: i + 1,
        playerId: r.playerId,
        handle: players.get(r.playerId)?.handle ?? '?',
        kind: players.get(r.playerId)?.kind ?? 'human',
        netWorth: r.netWorth,
      }));
    },

    holders(companyId) {
      const season = repos.seasons.current();
      if (!season) return [];
      const rows = repos.holdings.forCompany(season.id, companyId);
      const players = new Map(
        repos.players.many(rows.map((r) => r.playerId)).map((p) => [p.id, p]),
      );
      return rows
        .map((r) => ({
          handle: players.get(r.playerId)?.handle ?? '?',
          kind: players.get(r.playerId)?.kind ?? ('human' as const),
          longQty: r.longQty,
          shortQty: r.shortQty,
        }))
        .sort((a, b) => b.longQty + b.shortQty - (a.longQty + a.shortQty));
    },
  };
}
