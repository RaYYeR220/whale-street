import type { Holding } from './ledger';

export function settleHolding(h: Holding, price: number): number {
  return h.longQty * price + Math.max(0, h.shortCollateral - h.shortQty * price);
}

export interface SettlementEntry {
  playerId: string;
  holding: Holding;
}

export interface SettlementLine {
  playerId: string;
  cashDelta: number;
  longQty: number;
  shortQty: number;
}

export function settleCompany(
  entries: readonly SettlementEntry[],
  price: number,
): SettlementLine[] {
  return entries.map(({ playerId, holding }) => ({
    playerId,
    cashDelta: settleHolding(holding, price),
    longQty: holding.longQty,
    shortQty: holding.shortQty,
  }));
}
