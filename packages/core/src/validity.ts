import type { Position, Snapshot } from './types';

/** True for a finite, strictly positive price. */
export function isValidPx(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}

/** True when a position's numeric fields are all sane enough to compute with. */
export function isSanePosition(p: Position): boolean {
  return (
    Number.isFinite(p.size) &&
    p.size !== 0 &&
    isValidPx(p.entryPx) &&
    (p.liqPx === null || isValidPx(p.liqPx)) &&
    Number.isFinite(p.leverage) &&
    p.leverage > 0 &&
    Number.isFinite(p.marginUsed) &&
    p.marginUsed >= 0 &&
    Number.isFinite(p.unrealizedPnl)
  );
}

/** True when a snapshot's positions and account fields are all sane enough to compute with. */
export function isSaneSnapshot(s: Snapshot): boolean {
  if (!s.positions.every(isSanePosition)) return false;
  const coins = new Set(s.positions.map((p) => p.coin));
  if (coins.size !== s.positions.length) return false;
  return (
    Number.isFinite(s.accountValue) &&
    Number.isFinite(s.realizedSinceAnchor) &&
    Number.isFinite(s.fetchedAt)
  );
}
