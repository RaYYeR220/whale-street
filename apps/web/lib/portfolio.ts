/** Holding arithmetic for display (the engine's ledger is authoritative; this only reads it). */
import { PARAMS } from '@whale-street/core';
import type { HoldingView } from './api-types';

export const isShort = (h: HoldingView): boolean => h.shortQty > 0 && h.longQty === 0;

/** Average entry price: cost per share for a long, sale price per share for a short. */
export function avgEntry(h: HoldingView): number | null {
  if (isShort(h)) return h.shortCollateral / PARAMS.shortCollateralMultiple / h.shortQty;
  return h.longQty > 0 ? h.longCost / h.longQty : null;
}

/** Cash the player has in the holding: long cost, or the own-cash half of a short's collateral. */
export function invested(h: HoldingView): number {
  if (isShort(h)) return h.shortCollateral * (1 - 1 / PARAMS.shortCollateralMultiple);
  return h.longCost;
}

/** Profit at the current price, or null when the company has no live price. */
export function holdingPnl(h: HoldingView): number | null {
  if (h.price === null || !Number.isFinite(h.price)) return null;
  if (isShort(h)) return Math.max(0, h.shortCollateral - h.shortQty * h.price) - invested(h);
  return h.longQty * h.price - h.longCost;
}

export function holdingReturn(h: HoldingView): number | null {
  const pnl = holdingPnl(h);
  const base = invested(h);
  return pnl === null || !(base > 0) ? null : pnl / base;
}
