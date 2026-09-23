import { type AmmError, multiplier, type Pool, quoteBuy, quoteSell, sharePrice } from './amm';
import { PARAMS, type Params } from './params';
import type { CompanyStatus } from './types';
import { isValidPx } from './validity';

export interface Holding {
  longQty: number;
  longCost: number;
  shortQty: number;
  shortCollateral: number;
}

export interface Portfolio {
  cash: number;
  holdings: Readonly<Record<string, Holding>>;
}

export type OrderSide = 'BUY' | 'SELL' | 'SHORT' | 'COVER';

export interface Order {
  companyId: string;
  side: OrderSide;
  qty: number;
}

export type RejectReason =
  | 'COMPANY_NOT_TRADING'
  | 'INVALID_QTY'
  | 'INVALID_NAV'
  | 'INSUFFICIENT_CASH'
  | 'INSUFFICIENT_SHARES'
  | 'INSUFFICIENT_LIQUIDITY'
  | 'COVER_SHORT_FIRST'
  | 'CLOSE_LONG_FIRST'
  | 'IPO_ALLOCATION_EXCEEDED';

export interface Fill {
  companyId: string;
  side: OrderSide;
  qty: number;
  /** Always positive: paid for BUY/COVER, received for SELL/SHORT. */
  cash: number;
  avgPrice: number;
  nav: number;
  multiplierBefore: number;
  multiplierAfter: number;
  /** 0 unless a forced COVER's cost exceeded the released collateral; the excess, written off. */
  writeOffUsd: number;
}

export interface ExecContext {
  status: CompanyStatus;
  nav: number;
  /** Remaining IPO allocation for this player, if the company is in its IPO window. */
  ipoRemainingCash?: number;
  /** Engine-initiated (auto-cover, settlement): bypasses status and cash checks. */
  forced?: boolean;
}

export type ExecResult =
  | { ok: true; portfolio: Portfolio; pool: Pool; fill: Fill }
  | { ok: false; reason: RejectReason };

const EPS = 1e-9;

export const EMPTY_HOLDING: Holding = { longQty: 0, longCost: 0, shortQty: 0, shortCollateral: 0 };

export function newPortfolio(cash: number = PARAMS.seasonStartCash): Portfolio {
  return { cash, holdings: {} };
}

const reject = (reason: RejectReason): ExecResult => ({ ok: false, reason });
const fromAmm = (e: AmmError): RejectReason => e;

function withHolding(pf: Portfolio, companyId: string, h: Holding, cash: number): Portfolio {
  const holdings = { ...pf.holdings };
  const empty = h.longQty < EPS && h.shortQty < EPS && h.shortCollateral < EPS;
  if (empty) {
    const { [companyId]: _, ...rest } = holdings;
    return { cash, holdings: rest };
  }
  holdings[companyId] = h;
  return { cash, holdings };
}

/**
 * Once a short shrinks below EPS, any stray collateral (e.g. float dust from a partial cover)
 * is swept into cash and zeroed rather than silently dropped when the holding is cleaned up.
 */
function sweepShortDust(h: Holding, cash: number): { holding: Holding; cash: number } {
  if (h.shortQty < EPS && h.shortCollateral !== 0) {
    return { holding: { ...h, shortQty: 0, shortCollateral: 0 }, cash: cash + h.shortCollateral };
  }
  return { holding: h, cash };
}

export function executeOrder(
  pf: Portfolio,
  pool: Pool,
  order: Order,
  ctx: ExecContext,
  params: Params = PARAMS,
): ExecResult {
  if (ctx.status !== 'ACTIVE' && !ctx.forced) return reject('COMPANY_NOT_TRADING');
  if (!Number.isFinite(order.qty) || order.qty <= 0) return reject('INVALID_QTY');
  const h = pf.holdings[order.companyId] ?? EMPTY_HOLDING;
  const muBefore = multiplier(pool);
  const fill = (qty: number, cash: number, next: Pool, writeOffUsd = 0): Fill => ({
    companyId: order.companyId,
    side: order.side,
    qty,
    cash,
    avgPrice: cash / qty,
    nav: ctx.nav,
    multiplierBefore: muBefore,
    multiplierAfter: multiplier(next),
    writeOffUsd,
  });

  switch (order.side) {
    case 'BUY': {
      if (h.shortQty > EPS) return reject('COVER_SHORT_FIRST');
      const q = quoteBuy(pool, order.qty, ctx.nav, params);
      if (!q.ok) return reject(fromAmm(q.error));
      if (q.cash > pf.cash + EPS) return reject('INSUFFICIENT_CASH');
      if (ctx.ipoRemainingCash !== undefined && q.cash > ctx.ipoRemainingCash + EPS) {
        return reject('IPO_ALLOCATION_EXCEEDED');
      }
      const next: Holding = { ...h, longQty: h.longQty + order.qty, longCost: h.longCost + q.cash };
      return {
        ok: true,
        portfolio: withHolding(pf, order.companyId, next, pf.cash - q.cash),
        pool: q.pool,
        fill: fill(order.qty, q.cash, q.pool),
      };
    }
    case 'SELL': {
      if (h.longQty < order.qty - EPS) return reject('INSUFFICIENT_SHARES');
      const qty = Math.min(order.qty, h.longQty);
      const q = quoteSell(pool, qty, ctx.nav, params);
      if (!q.ok) return reject(fromAmm(q.error));
      const costPortion = h.longQty > 0 ? h.longCost * (qty / h.longQty) : 0;
      const next: Holding = { ...h, longQty: h.longQty - qty, longCost: h.longCost - costPortion };
      return {
        ok: true,
        portfolio: withHolding(pf, order.companyId, next, pf.cash + q.cash),
        pool: q.pool,
        fill: fill(qty, q.cash, q.pool),
      };
    }
    case 'SHORT': {
      if (h.longQty > EPS) return reject('CLOSE_LONG_FIRST');
      const q = quoteSell(pool, order.qty, ctx.nav, params);
      if (!q.ok) return reject(fromAmm(q.error));
      const m = params.shortCollateralMultiple;
      const matching = (m - 1) * q.cash;
      if (matching > pf.cash + EPS) return reject('INSUFFICIENT_CASH');
      const next: Holding = {
        ...h,
        shortQty: h.shortQty + order.qty,
        shortCollateral: h.shortCollateral + m * q.cash,
      };
      return {
        ok: true,
        portfolio: withHolding(pf, order.companyId, next, pf.cash - matching),
        pool: q.pool,
        fill: fill(order.qty, q.cash, q.pool),
      };
    }
    case 'COVER': {
      if (h.shortQty < order.qty - EPS) return reject('INSUFFICIENT_SHARES');
      const qty = Math.min(order.qty, h.shortQty);
      const q = quoteBuy(pool, qty, ctx.nav, params);
      let cost: number;
      let nextPool: Pool;
      if (q.ok) {
        cost = q.cash;
        nextPool = q.pool;
      } else if (ctx.forced && q.error === 'INSUFFICIENT_LIQUIDITY') {
        // The AMM floor can't quote this buy-back; fall back to the NAV share price so a
        // forced auto-cover can never dead-end. The pool itself is left untouched.
        cost = sharePrice(ctx.nav, pool) * qty * (1 + params.feeRate);
        nextPool = pool;
      } else {
        return reject(fromAmm(q.error));
      }
      const released = h.shortCollateral * (qty / h.shortQty);

      let cash: number;
      let writeOffUsd = 0;
      if (ctx.forced) {
        // A short's loss is capped at its collateral whenever the engine forces the outcome:
        // any cost beyond what was released is written off, never drawn from free cash.
        writeOffUsd = Math.max(0, cost - released);
        cash = pf.cash + Math.max(0, released - cost);
      } else {
        const net = released - cost;
        if (pf.cash + net < -EPS) return reject('INSUFFICIENT_CASH');
        cash = Math.max(0, pf.cash + net);
      }

      const rawNext: Holding = {
        ...h,
        shortQty: h.shortQty - qty,
        shortCollateral: h.shortCollateral - released,
      };
      const swept = sweepShortDust(rawNext, cash);
      return {
        ok: true,
        portfolio: withHolding(pf, order.companyId, swept.holding, swept.cash),
        pool: nextPool,
        fill: fill(qty, cost, nextPool, writeOffUsd),
      };
    }
  }
}

/** A short's loss is capped at its collateral, same as settleHolding. */
export function holdingValue(h: Holding, price: number): number {
  return h.longQty * price + Math.max(0, h.shortCollateral - h.shortQty * price);
}

/** null if any held company's price is missing or invalid, rather than silently pricing it at 0. */
export function netWorth(pf: Portfolio, prices: Readonly<Record<string, number>>): number | null {
  let total = pf.cash;
  for (const [id, h] of Object.entries(pf.holdings)) {
    const price = prices[id];
    if (!isValidPx(price)) return null;
    total += holdingValue(h, price);
  }
  return total;
}

export function needsAutoCover(
  h: Holding,
  pool: Pool,
  nav: number,
  params: Params = PARAMS,
): boolean {
  if (h.shortQty <= EPS) return false;
  const q = quoteBuy(pool, h.shortQty, nav, params);
  if (!q.ok) return true;
  return q.cash >= params.autoCoverAt * h.shortCollateral;
}
