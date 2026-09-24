import { type Address, type Maybe, none, type Position, some } from '@whale-street/core';
import type { HlInfo } from '@whale-street/hl';
import type { NansenPort } from '../ports';

export interface PositionsResult {
  positions: Position[];
  accountValue: number;
  /** Nansen call ids, or `hl:clearinghouseState` when served by Hyperliquid in credit-saver mode. */
  provenance: string[];
  source: 'nansen' | 'hyperliquid';
}

/**
 * A row at exactly zero size is a closed coin (Hyperliquid, and Nansen proxying it, may still list
 * one), not a position. Anything else stays, so a non-finite size still fails the sanity checks.
 */
const open = (positions: readonly Position[]): Position[] => positions.filter((p) => p.size !== 0);

/**
 * Live positions + equity for an address. Nansen profiler/perp-positions normally;
 * Hyperliquid clearinghouseState (free, same underlying source) when `creditSaver` is set: the
 * caller decides, since credit-saver moves only routine refreshes to Hyperliquid.
 */
export async function fetchPositions(
  address: Address,
  d: { nansen: NansenPort; info: HlInfo; creditSaver: boolean },
): Promise<Maybe<PositionsResult>> {
  if (d.creditSaver) {
    const r = await d.info.clearinghouse(address);
    if (!r.ok) return none(`hyperliquid: ${r.error}`);
    if (!Number.isFinite(r.value.accountValue)) return none('hyperliquid: invalid account value');
    return some({
      positions: open(r.value.positions),
      accountValue: r.value.accountValue,
      provenance: ['hl:clearinghouseState'],
      source: 'hyperliquid',
    });
  }
  const r = await d.nansen.perpPositions(address);
  if (!r.ok) return none(`nansen: ${r.error}`);
  if (!Number.isFinite(r.value.accountValue)) return none('nansen: invalid account value');
  return some({
    positions: open(r.value.positions),
    accountValue: r.value.accountValue,
    provenance: [r.callId],
    source: 'nansen',
  });
}
