import { PARAMS, type Params } from './params';
import type { Marks, Position } from './types';
import { isSanePosition, isValidPx } from './validity';

export function positionHp(p: Position, mark: number): number {
  if (p.liqPx === null || p.size === 0) return 1;
  const span = Math.abs(p.entryPx - p.liqPx);
  if (span < 1e-12) return 0;
  const dist = p.size > 0 ? mark - p.liqPx : p.liqPx - mark;
  return Math.min(1, Math.max(0, dist / span));
}

/** Display HP: lenient, skips positions whose mark is missing or invalid. */
export function computeHp(positions: readonly Position[], marks: Marks): number {
  let hp = 1;
  for (const p of positions) {
    const m = marks[p.coin];
    if (!isValidPx(m)) continue;
    hp = Math.min(hp, positionHp(p, m));
  }
  return hp;
}

/** Strict HP for trading gates: null (never allow) if any position is unsane or unpriced. */
export function computeHpStrict(positions: readonly Position[], marks: Marks): number | null {
  let hp = 1;
  for (const p of positions) {
    if (!isSanePosition(p)) return null;
    const m = marks[p.coin];
    if (!isValidPx(m)) return null;
    hp = Math.min(hp, positionHp(p, m));
  }
  return hp;
}

export function marginCallCrossed(
  hpBefore: number,
  hpAfter: number,
  params: Params = PARAMS,
): boolean {
  return hpBefore >= params.marginCallHp && hpAfter < params.marginCallHp;
}
