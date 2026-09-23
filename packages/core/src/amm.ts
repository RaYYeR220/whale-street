import { PARAMS, type Params } from './params';

export interface Pool {
  /** Virtual share reserve. */
  x: number;
  /** Virtual hype-unit reserve. */
  y: number;
  /** Initial depth; the share reserve may not drop below minReserveFrac · l0. */
  l0: number;
}

export type AmmError = 'INVALID_QTY' | 'INVALID_NAV' | 'INSUFFICIENT_LIQUIDITY';
export type Quote = { ok: true; cash: number; pool: Pool } | { ok: false; error: AmmError };

const validQty = (q: number) => Number.isFinite(q) && q > 0;
const validNav = (n: number) => Number.isFinite(n) && n > 0;

export function createPool(depth: number = PARAMS.poolDepth): Pool {
  return { x: depth, y: depth, l0: depth };
}

export const multiplier = (p: Pool): number => p.y / p.x;
export const sharePrice = (nav: number, p: Pool): number => nav * multiplier(p);

export function quoteBuy(p: Pool, qty: number, nav: number, params: Params = PARAMS): Quote {
  if (!validQty(qty)) return { ok: false, error: 'INVALID_QTY' };
  if (!validNav(nav)) return { ok: false, error: 'INVALID_NAV' };
  const x2 = p.x - qty;
  if (x2 < params.minReserveFrac * p.l0) return { ok: false, error: 'INSUFFICIENT_LIQUIDITY' };
  const y2 = (p.x * p.y) / x2;
  return {
    ok: true,
    cash: nav * (y2 - p.y) * (1 + params.feeRate),
    pool: { x: x2, y: y2, l0: p.l0 },
  };
}

export function quoteSell(p: Pool, qty: number, nav: number, params: Params = PARAMS): Quote {
  if (!validQty(qty)) return { ok: false, error: 'INVALID_QTY' };
  if (!validNav(nav)) return { ok: false, error: 'INVALID_NAV' };
  const x2 = p.x + qty;
  const y2 = (p.x * p.y) / x2;
  return {
    ok: true,
    cash: nav * (p.y - y2) * (1 - params.feeRate),
    pool: { x: x2, y: y2, l0: p.l0 },
  };
}

/** Largest share quantity whose buy cost (incl. fee) fits in `cash`. */
export function qtyForCash(p: Pool, cash: number, nav: number, params: Params = PARAMS): number {
  if (!(cash > 0) || !validNav(nav)) return 0;
  const y2 = p.y + cash / (nav * (1 + params.feeRate));
  const x2 = (p.x * p.y) / y2;
  const cap = p.x - params.minReserveFrac * p.l0;
  return Math.max(0, Math.min(p.x - x2, cap) * (1 - 1e-12));
}

/** Relax the hype multiplier toward 1 (funding-like decay). */
export function decayPool(p: Pool, dtMs: number, params: Params = PARAMS): Pool {
  if (!(dtMs > 0)) return p;
  const mu = p.y / p.x;
  const mu2 = 1 + (mu - 1) * Math.exp(-dtMs / params.hypeTauMs);
  return { x: p.x, y: mu2 * p.x, l0: p.l0 };
}
